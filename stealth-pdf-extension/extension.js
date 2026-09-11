const vscode = require('vscode');
const path = require('path');
const https = require('https');
const { PDFDocument, degrees } = require('./lib/pdf-lib.min.js');

let activePanel = null;
let activeFileUri = null;
let lastPdfUri = null;
let isBossActive = false;
let reloadActivePdf = null;
const statusItems = {};

async function getDoodles(context, filePath) {
  try {
    const hash = Buffer.from(filePath).toString('hex');
    const doodleUri = vscode.Uri.joinPath(context.globalStorageUri, `${hash}.json`);
    const bytes = await vscode.workspace.fs.readFile(doodleUri);
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (e) {
    return {};
  }
}

async function saveDoodles(context, filePath, doodles) {
  try {
    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const hash = Buffer.from(filePath).toString('hex');
    const doodleUri = vscode.Uri.joinPath(context.globalStorageUri, `${hash}.json`);
    const content = Buffer.from(JSON.stringify(doodles), 'utf8');
    await vscode.workspace.fs.writeFile(doodleUri, content);
  } catch (e) {
    console.error('Failed to save doodles:', e);
  }
}

// ===================== Gitee 云端同步（仅同步当前打开的 PDF） =====================

function getGiteeConfig() {
  const cfg = vscode.workspace.getConfiguration('stealth-pdf');
  return {
    token: cfg.get('gitee.token') || '',
    repo: cfg.get('gitee.repo') || '',
    branch: cfg.get('gitee.branch') || 'master'
  };
}

async function promptGiteeConfig(config) {
  const token = await vscode.window.showInputBox({
    prompt: '输入 Gitee 私人令牌 (设置-私人令牌-生成新令牌，勾选 projects)',
    password: true,
    ignoreFocusOut: true
  });
  if (!token) return false;
  const repo = await vscode.window.showInputBox({
    prompt: '输入用于同步的 Gitee 仓库路径 (如: myname/my-notes，支持私有仓库)',
    placeHolder: 'owner/repo',
    ignoreFocusOut: true
  });
  if (!repo) return false;

  const cfg = vscode.workspace.getConfiguration('stealth-pdf');
  await cfg.update('gitee.token', token, vscode.ConfigurationTarget.Global);
  await cfg.update('gitee.repo', repo, vscode.ConfigurationTarget.Global);
  config.token = token;
  config.repo = repo;
  return true;
}

function giteeRequest(method, pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({
      hostname: 'gitee.com',
      path: '/api/v5' + pathname,
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        body ? { 'Content-Length': Buffer.byteLength(body) } : {}
      ),
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch (e) {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => req.destroy(new Error('连接 Gitee 超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function giteeErrMsg(res, fallback) {
  return (res.body && (res.body.message || res.body.errorMessage)) || fallback + ` (HTTP ${res.status})`;
}

async function uploadToGitee(config, cloudPath, contentBuffer, message) {
  const encPath = encodeURIComponent(cloudPath);
  const query = `?access_token=${encodeURIComponent(config.token)}&ref=${encodeURIComponent(config.branch)}`;

  const head = await giteeRequest('GET', `/repos/${config.repo}/contents/${encPath}${query}`);
  if (head.status !== 200 && head.status !== 404) {
    throw new Error(giteeErrMsg(head, '检查云端文件失败'));
  }

  const payload = {
    access_token: config.token,
    content: contentBuffer.toString('base64'),
    branch: config.branch,
    message
  };
  if (head.status === 200 && head.body && head.body.sha) {
    payload.sha = head.body.sha; // 已存在则更新
  }

  const res = await giteeRequest('PUT', `/repos/${config.repo}/contents/${encPath}`, payload);
  if (res.status !== 200 && res.status !== 201) {
    throw new Error(giteeErrMsg(res, '上传到 Gitee 失败'));
  }
}

async function downloadFromGitee(config, cloudPath) {
  const encPath = encodeURIComponent(cloudPath);
  const query = `?access_token=${encodeURIComponent(config.token)}&ref=${encodeURIComponent(config.branch)}`;
  const res = await giteeRequest('GET', `/repos/${config.repo}/contents/${encPath}${query}`);
  if (res.status === 404) return null;
  if (res.status !== 200 || !res.body || !res.body.content) {
    throw new Error(giteeErrMsg(res, '从 Gitee 下载失败'));
  }
  return Buffer.from(res.body.content.replace(/\n/g, ''), 'base64');
}

async function cloudSyncCurrentPdf(context) {
  if (!activeFileUri) {
    vscode.window.showWarningMessage('请先打开要同步的题册 PDF');
    return;
  }

  const config = getGiteeConfig();
  if (!config.token || !config.repo) {
    if (!await promptGiteeConfig(config)) return;
  }

  const pick = await vscode.window.showQuickPick([
    { label: '$(cloud-upload) 上传当前题册到云端', detail: '将当前 PDF 及做题笔记推送至 Gitee 仓库', action: 'push' },
    { label: '$(cloud-download) 从云端拉取当前题册', detail: '用云端版本覆盖本地 PDF 并恢复笔记', action: 'pull' }
  ], { placeHolder: 'Gitee 云同步（仅同步当前打开的 PDF 及其笔记，不影响其他文件）' });
  if (!pick) return;

  const fileName = path.basename(activeFileUri.fsPath);
  const cloudPath = `StealthPDFSync/${Buffer.from(activeFileUri.fsPath).toString('hex').slice(0, 12)}_${fileName}`;

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Gitee 云同步: ${fileName}` },
      async () => {
        if (pick.action === 'push') {
          const pdfBytes = Buffer.from(await vscode.workspace.fs.readFile(activeFileUri));
          await uploadToGitee(config, cloudPath, pdfBytes, `sync: ${fileName}`);

          const doodles = await getDoodles(context, activeFileUri.fsPath);
          if (Object.keys(doodles).length > 0) {
            const notesBuf = Buffer.from(JSON.stringify(doodles), 'utf8');
            await uploadToGitee(config, cloudPath + '.notes.json', notesBuf, `sync notes: ${fileName}`);
          }
          vscode.window.setStatusBarMessage(`$(check) 题册已同步至 Gitee: ${fileName}`, 4000);
        } else {
          const remote = await downloadFromGitee(config, cloudPath);
          if (!remote) {
            vscode.window.showWarningMessage('云端未找到该题册，请先在其他设备上传');
            return;
          }
          await vscode.workspace.fs.writeFile(activeFileUri, remote);

          const remoteNotes = await downloadFromGitee(config, cloudPath + '.notes.json');
          if (remoteNotes) {
            await saveDoodles(context, activeFileUri.fsPath, JSON.parse(remoteNotes.toString('utf8')));
          }
          if (reloadActivePdf) reloadActivePdf();
          vscode.window.setStatusBarMessage(`$(check) 已从 Gitee 拉取题册: ${fileName}`, 4000);
        }
      }
    );
  } catch (err) {
    vscode.window.showErrorMessage('Gitee 云同步失败: ' + err.message);
  }
}

async function saveDoodlesToPdf(fileUri, doodles) {
  const pageEntries = Object.entries(doodles || {});
  if (pageEntries.length === 0) {
    vscode.window.setStatusBarMessage(`$(check) 题册已保存 (当前无涂鸦笔迹)`, 3000);
    return true;
  }

  vscode.window.setStatusBarMessage(`$(sync~spin) 正在合成涂鸦笔记至原题册...`, 15000);

  try {
    const fileBytes = await vscode.workspace.fs.readFile(fileUri);
    const pdfDoc = await PDFDocument.load(fileBytes, {
      ignoreEncryption: true,
      throwOnInvalidObject: false
    });

    if (pdfDoc.isEncrypted) {
      return false;
    }

    const pages = pdfDoc.getPages();

    for (const [pageNumStr, dataUrl] of pageEntries) {
      const pageNum = parseInt(pageNumStr);
      if (!dataUrl || pageNum < 1 || pageNum > pages.length) continue;

      const targetPage = pages[pageNum - 1];
      const pngImage = await pdfDoc.embedPng(dataUrl);
      const { width, height } = targetPage.getSize();
      const rot = (targetPage.getRotation() ? targetPage.getRotation().angle : 0) % 360;

      if (rot === 0) {
        targetPage.drawImage(pngImage, { x: 0, y: 0, width, height });
      } else {
        targetPage.drawImage(pngImage, {
          x: rot === 90 ? width : 0,
          y: rot === 270 ? height : 0,
          width: (rot === 90 || rot === 270) ? height : width,
          height: (rot === 90 || rot === 270) ? width : height,
          rotate: degrees(rot)
        });
      }
    }

    const modifiedBytes = await pdfDoc.save();
    await vscode.workspace.fs.writeFile(fileUri, modifiedBytes);
    vscode.window.setStatusBarMessage(`$(check) 题册做题笔迹已成功写回原文件: ${path.basename(fileUri.fsPath)}`, 4000);
    return true;
  } catch (err) {
    console.warn('Direct PDF file write skipped (encrypted or protected structure):', err.message);
    return false;
  }
}

function activate(context) {
  initStatusBar(context);

  // 1. 注册 Custom Editor Provider (默认 PDF 打开方式)
  const provider = {
    async openCustomDocument(uri) {
      return { uri, dispose: () => {} };
    },
    async resolveCustomEditor(document, panel) {
      setupEditorPanel(context, panel, document.uri);
    }
  };

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider('stealth-pdf.editor', provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    })
  );

  // 2. 命令面板手动打开
  context.subscriptions.push(
    vscode.commands.registerCommand('stealth-pdf.open', async (uri) => {
      let fileUri = uri;
      if (!fileUri) {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectFolders: false,
          canSelectMany: false,
          filters: { 'PDF 题册': ['pdf'] },
          openLabel: '加载题册'
        });
        if (!selected || selected.length === 0) return;
        fileUri = selected[0];
      }
      vscode.commands.executeCommand('vscode.openWith', fileUri, 'stealth-pdf.editor');
    })
  );

  // 3. 注册所有控制与老板键命令
  registerControlCommands(context);
}

function initStatusBar(context) {
  const prioBase = 100;

  // Gitee 云同步
  statusItems.sync = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 11);
  statusItems.sync.text = '$(cloud) 同步';
  statusItems.sync.tooltip = 'Gitee 云同步当前题册 (仅同步打开的 PDF 及其笔记)';
  statusItems.sync.command = 'stealth-pdf.syncCloud';

  // 翻页与跳页
  statusItems.prev = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 10);
  statusItems.prev.text = '$(chevron-left)';
  statusItems.prev.tooltip = '上一页 (A / ←)';
  statusItems.prev.command = 'stealth-pdf.prevPage';

  statusItems.page = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 9);
  statusItems.page.text = '$(file-code) -/-';
  statusItems.page.tooltip = '点击跳转页码';
  statusItems.page.command = 'stealth-pdf.jumpPage';

  statusItems.next = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 8);
  statusItems.next.text = '$(chevron-right)';
  statusItems.next.tooltip = '下一页 (D / →)';
  statusItems.next.command = 'stealth-pdf.nextPage';

  // 工具：笔 / 荧光 / 橡皮
  statusItems.pen = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 7);
  statusItems.pen.text = '$(edit) 笔';
  statusItems.pen.tooltip = '画笔 (快捷键 1)';
  statusItems.pen.command = 'stealth-pdf.setPen';

  statusItems.highlighter = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 6);
  statusItems.highlighter.text = '$(sparkle) 荧光';
  statusItems.highlighter.tooltip = '荧光划线 (快捷键 2)';
  statusItems.highlighter.command = 'stealth-pdf.setHighlighter';

  statusItems.eraser = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 5);
  statusItems.eraser.text = '$(trash) 擦';
  statusItems.eraser.tooltip = '橡皮擦 (快捷键 3)';
  statusItems.eraser.command = 'stealth-pdf.setEraser';

  // 颜色与粗细 (粗细支持最小 1px)
  statusItems.color = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 4);
  statusItems.color.text = '$(symbol-color) 红';
  statusItems.color.tooltip = '切换颜色 (红/蓝/绿/灰/黄)';
  statusItems.color.command = 'stealth-pdf.cycleColor';

  statusItems.width = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 3);
  statusItems.width.text = '$(dash) 2px';
  statusItems.width.tooltip = '画笔粗细 (点击切换: 1px/2px/3px/5px，支持按 [ 或 ] 微调)';
  statusItems.width.command = 'stealth-pdf.cycleWidth';

  // 撤销
  statusItems.undo = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 2);
  statusItems.undo.text = '$(discard)';
  statusItems.undo.tooltip = '撤销笔迹 (Ctrl+Z)';
  statusItems.undo.command = 'stealth-pdf.undo';

  // 代码黑滤镜
  statusItems.dark = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase + 1);
  statusItems.dark.text = '$(eye-closed) 代码黑';
  statusItems.dark.tooltip = '切换代码黑深色滤镜';
  statusItems.dark.command = 'stealth-pdf.toggleDark';

  // 实时保存
  statusItems.save = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase);
  statusItems.save.text = '$(save) 存';
  statusItems.save.tooltip = '保存题册笔迹 (Ctrl+S)';
  statusItems.save.command = 'stealth-pdf.save';

  // 老板键切走后保留的返回状态栏入口 (伪装成普通状态)
  statusItems.bossReturn = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, prioBase);
  statusItems.bossReturn.text = '$(chevron-left) 回到题册';
  statusItems.bossReturn.tooltip = '按 Esc 或点击切回题册';
  statusItems.bossReturn.command = 'stealth-pdf.bossToggle';

  Object.values(statusItems).forEach(item => context.subscriptions.push(item));
}

function showEditorStatusItems() {
  statusItems.bossReturn.hide();
  for (const [key, item] of Object.entries(statusItems)) {
    if (key !== 'bossReturn') item.show();
  }
}
function hideEditorStatusItems() {
  for (const [key, item] of Object.entries(statusItems)) {
    if (key !== 'bossReturn') item.hide();
  }
}

function registerControlCommands(context) {
  const send = (action, payload = {}) => {
    if (activePanel) {
      activePanel.webview.postMessage({ type: 'control', action, ...payload });
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('stealth-pdf.prevPage', () => send('prevPage')),
    vscode.commands.registerCommand('stealth-pdf.nextPage', () => send('nextPage')),
    vscode.commands.registerCommand('stealth-pdf.setPen', () => send('setTool', { tool: 'pen' })),
    vscode.commands.registerCommand('stealth-pdf.setHighlighter', () => send('setTool', { tool: 'highlighter' })),
    vscode.commands.registerCommand('stealth-pdf.setEraser', () => send('setTool', { tool: 'eraser' })),
    vscode.commands.registerCommand('stealth-pdf.undo', () => send('undo')),
    vscode.commands.registerCommand('stealth-pdf.cycleColor', () => send('cycleColor')),
    vscode.commands.registerCommand('stealth-pdf.cycleWidth', () => send('cycleWidth')),
    vscode.commands.registerCommand('stealth-pdf.toggleDark', () => send('toggleDark')),
    vscode.commands.registerCommand('stealth-pdf.save', () => send('save')),
    vscode.commands.registerCommand('stealth-pdf.jumpPage', async () => {
      const input = await vscode.window.showInputBox({
        prompt: '跳转至页码',
        placeHolder: '如: 12'
      });
      if (input && !isNaN(parseInt(input))) {
        send('setPage', { page: parseInt(input) });
      }
    }),
    // 核心：老板键跳出与切回命令
    vscode.commands.registerCommand('stealth-pdf.bossToggle', async () => {
      await handleBossToggle();
    }),
    vscode.commands.registerCommand('stealth-pdf.syncCloud', () => cloudSyncCurrentPdf(context))
  );
}

// 寻找当前目录或工作区下的真实代码文件作为掩护
async function findDisguiseFile(pdfUri) {
  if (pdfUri) {
    try {
      const parentDir = path.dirname(pdfUri.fsPath);
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.file(parentDir));
      for (const [name, type] of entries) {
        if (type === vscode.FileType.File && !name.toLowerCase().endsWith('.pdf') && !name.toLowerCase().endsWith('.vsix')) {
          return vscode.Uri.file(path.join(parentDir, name));
        }
      }
    } catch (e) {}
  }

  // 工作区查找
  const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 20);
  const nonPdf = files.find(f => !f.fsPath.toLowerCase().endsWith('.pdf') && !f.fsPath.toLowerCase().endsWith('.vsix'));
  if (nonPdf) return nonPdf;

  return null;
}

// 执行老板键切换
async function handleBossToggle() {
  if (!isBossActive) {
    // 处于题册中，紧急跳到代码文件
    if (activeFileUri) {
      lastPdfUri = activeFileUri;
    }
    const disguiseUri = await findDisguiseFile(lastPdfUri);
    if (disguiseUri) {
      await vscode.window.showTextDocument(disguiseUri, { preview: false });
    } else {
      // 若无其他文件，秒开一个假 Go 代码文档
      const doc = await vscode.workspace.openTextDocument({
        language: 'go',
        content: `package main\n\nimport (\n\t"context"\n\t"fmt"\n\t"time"\n)\n\n// StreamDispatcher coordinates chunk buffer routing\nfunc StreamDispatcher(ctx context.Context) error {\n\ttime.Sleep(10 * time.Millisecond)\n\tfmt.Println("telemetry packet synced")\n\treturn nil\n}\n`
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }

    isBossActive = true;
    vscode.commands.executeCommand('setContext', 'stealthPdfBossActive', true);
    statusItems.bossReturn.show();
  } else {
    // 处于代码文件中，一键切回题册
    isBossActive = false;
    vscode.commands.executeCommand('setContext', 'stealthPdfBossActive', false);
    statusItems.bossReturn.hide();

    if (lastPdfUri) {
      await vscode.commands.executeCommand('vscode.openWith', lastPdfUri, 'stealth-pdf.editor');
    }
  }
}

function setupEditorPanel(context, panel, fileUri) {
  panel.webview.options = {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [context.extensionUri]
  };

  const pdfJsUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'lib', 'pdf.min.js'));
  const pdfWorkerUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'lib', 'pdf.worker.min.js'));
  const pdfLibUri = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'lib', 'pdf-lib.min.js'));

  panel.webview.html = getWebviewContent(panel.webview, { pdfJsUri, pdfWorkerUri, pdfLibUri });

  const stateKey = 'pdf_state:' + fileUri.fsPath;
  const savedState = context.globalState.get(stateKey) || {};

  let cachedDoodles = {};
  let pendingPdfData = null;

  async function loadFile() {
    try {
      cachedDoodles = await getDoodles(context, fileUri.fsPath);
      const fileBytes = await vscode.workspace.fs.readFile(fileUri);
      const base64Data = Buffer.from(fileBytes).toString('base64');
      const fileName = path.basename(fileUri.fsPath);

      pendingPdfData = {
        type: 'loadPdf',
        data: base64Data,
        fileName: fileName,
        filePath: fileUri.fsPath,
        initialPage: savedState.page || 1,
        initialTool: savedState.tool || 'pen',
        initialColor: savedState.color || '#e06c75',
        initialWidth: savedState.width !== undefined ? savedState.width : 2,
        initialFilter: savedState.filter !== undefined ? savedState.filter : 'dark-ide',
        initialScale: savedState.scale || 1.25,
        initialDoodles: cachedDoodles
      };
      panel.webview.postMessage(pendingPdfData);
    } catch (err) {
      vscode.window.showErrorMessage('读取 PDF 失败: ' + err.message);
    }
  }
  loadFile();

  // 激活状态维护 (使用 visible 避免点击状态栏按钮时 activePanel 丢失)
  if (panel.visible) {
    activePanel = panel;
    activeFileUri = fileUri;
    isBossActive = false;
    vscode.commands.executeCommand('setContext', 'stealthPdfBossActive', false);
    showEditorStatusItems();
  }

  panel.onDidChangeViewState(e => {
    if (e.webviewPanel.visible) {
      activePanel = panel;
      activeFileUri = fileUri;
      isBossActive = false;
      vscode.commands.executeCommand('setContext', 'stealthPdfBossActive', false);
      showEditorStatusItems();
    } else if (activePanel === panel) {
      activePanel = null;
      hideEditorStatusItems();
    }
  });

  panel.onDidDispose(() => {
    if (activePanel === panel) {
      activePanel = null;
      hideEditorStatusItems();
    }
    if (reloadActivePdf === reloadFn) {
      reloadActivePdf = null;
    }
  });

  function reloadFn() {
    loadFile();
  }
  reloadActivePdf = reloadFn;

  // 接收 Webview 消息
  panel.webview.onDidReceiveMessage(async (message) => {
    if (message.type === 'ready') {
      if (pendingPdfData) {
        panel.webview.postMessage(pendingPdfData);
      }
    } else if (message.type === 'bossJump') {
      // Webview 中按下 Esc
      lastPdfUri = fileUri;
      await handleBossToggle();
    } else if (message.type === 'stateUpdate') {
      // 状态持久化
      context.globalState.update(stateKey, {
        page: message.page,
        tool: message.tool,
        color: message.color,
        width: message.width,
        filter: message.filter,
        scale: message.scale
      });

      // 实时同步底部状态栏
      statusItems.page.text = `$(file-code) ${message.page}/${message.total}`;
      statusItems.pen.text = message.tool === 'pen' ? '$(edit) [笔]' : '$(edit) 笔';
      statusItems.highlighter.text = message.tool === 'highlighter' ? '$(sparkle) [荧光]' : '$(sparkle) 荧光';
      statusItems.eraser.text = message.tool === 'eraser' ? '$(trash) [擦]' : '$(trash) 擦';

      const colorNames = {
        '#e06c75': '红',
        '#61afef': '蓝',
        '#98c379': '绿',
        '#858585': '灰',
        '#e5c07b': '黄'
      };
      statusItems.color.text = `$(symbol-color) ${colorNames[message.color] || '色'}`;
      statusItems.width.text = `$(dash) ${message.width}px`;
      statusItems.dark.text = message.filter === 'dark-ide' ? '$(eye-closed) 代码黑' : '$(eye) 原色';
    } else if (message.type === 'autoSaveDoodle') {
      if (message.doodle) {
        cachedDoodles[message.page] = message.doodle;
      } else {
        delete cachedDoodles[message.page];
      }
      await saveDoodles(context, fileUri.fsPath, cachedDoodles);
    } else if (message.type === 'savePdf') {
      try {
        if (message.doodles) {
          cachedDoodles = { ...cachedDoodles, ...message.doodles };
        }
        await saveDoodles(context, fileUri.fsPath, cachedDoodles);

        const embedded = await saveDoodlesToPdf(fileUri, cachedDoodles);
        if (!embedded) {
          vscode.window.setStatusBarMessage(`$(check) 题册做题笔迹已安全保存至本地 (重开自动恢复)`, 4000);
        }
      } catch (err) {
        console.error('Save error:', err);
        vscode.window.showErrorMessage('保存笔记失败: ' + err.message);
      }
    }
  });
}

function getWebviewContent(webview, uris) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob: data:; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} blob: data:; worker-src ${webview.cspSource} blob: data:; style-src 'unsafe-inline' ${webview.cspSource}; font-src ${webview.cspSource} blob: data:; connect-src ${webview.cspSource} blob: data:;">
  <script src="${uris.pdfJsUri}"></script>
  <script src="${uris.pdfWorkerUri}"></script>
  <script src="${uris.pdfLibUri}"></script>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      user-select: none;
    }
    body {
      background-color: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      cursor: default; /* 原生系统鼠标 */
    }

    #main-viewport {
      flex: 1;
      position: relative;
      overflow: auto;
      display: flex;
      align-items: flex-start;
      padding: 12px;
      background: var(--vscode-editor-background, #1e1e1e);
      cursor: default;
    }
    #page-wrapper {
      position: relative;
      box-shadow: 0 4px 18px rgba(0,0,0,0.5);
      border-radius: 2px;
      transform-origin: top center;
      margin: 0 auto;
    }
    #pdf-canvas, #draw-canvas {
      position: absolute;
      top: 0;
      left: 0;
      display: block;
      cursor: default; /* 原生鼠标指针，不再使用十字星 */
    }
    #draw-canvas {
      z-index: 10;
      touch-action: none;
    }

    /* 代码黑滤镜 */
    .filter-dark-ide {
      filter: invert(0.92) hue-rotate(180deg) contrast(0.9) brightness(0.85);
    }
  </style>
</head>
<body>

  <div id="main-viewport">
    <div id="page-wrapper" class="filter-dark-ide">
      <canvas id="pdf-canvas"></canvas>
      <canvas id="draw-canvas"></canvas>
    </div>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = '${uris.pdfWorkerUri}';
    }

    let pdfDoc = null;
    let originalPdfBytes = null;
    let originalFileName = "";
    let currentPageNum = 1;
    let totalPages = 0;
    let currentScale = 1.25;
    let currentFilter = 'dark-ide';

    let currentTool = 'pen';
    const colorList = ['#e06c75', '#61afef', '#98c379', '#858585', '#e5c07b'];
    let colorIndex = 0;
    let currentColor = colorList[0];
    
    // 画笔粗细：支持 1px / 2px / 3px / 5px，最小 1px
    const widthList = [1, 2, 3, 5];
    let widthIndex = 1;
    let currentLineWidth = 2;

    let isDrawing = false;
    let isDrawingDirty = false;
    let lastX = 0;
    let lastY = 0;

    let currentRenderTask = null;
    let isRendering = false;
    let pendingRender = false;

    const pageDoodles = new Map();
    const pageHasDoodles = new Set();
    const undoStacks = new Map();

    const pdfCanvas = document.getElementById('pdf-canvas');
    const drawCanvas = document.getElementById('draw-canvas');
    const pdfCtx = pdfCanvas.getContext('2d');
    const drawCtx = drawCanvas.getContext('2d');
    const pageWrapper = document.getElementById('page-wrapper');

    function notifyState() {
      vscode.postMessage({
        type: 'stateUpdate',
        page: currentPageNum,
        total: totalPages,
        tool: currentTool,
        color: currentColor,
        width: currentLineWidth,
        filter: currentFilter,
        scale: currentScale
      });
    }

    window.addEventListener('message', async (event) => {
      const msg = event.data;
      if (msg.type === 'loadPdf') {
        try {
          originalFileName = msg.fileName;
          const binaryString = atob(msg.data);
          const len = binaryString.length;
          const bytes = new Uint8Array(len);
          for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          originalPdfBytes = bytes;

          const loadingTask = pdfjsLib.getDocument({
            data: originalPdfBytes,
            cMapPacked: true
          });
          pdfDoc = await loadingTask.promise;
          totalPages = pdfDoc.numPages;

          // 恢复缓存状态
          currentPageNum = (msg.initialPage && msg.initialPage >= 1 && msg.initialPage <= totalPages) 
            ? msg.initialPage 
            : 1;
          if (msg.initialScale) currentScale = msg.initialScale;
          if (msg.initialTool) currentTool = msg.initialTool;
          if (msg.initialColor) {
            currentColor = msg.initialColor;
            const idx = colorList.indexOf(currentColor);
            if (idx !== -1) colorIndex = idx;
          }
          if (msg.initialWidth !== undefined) {
            currentLineWidth = Math.max(1, msg.initialWidth);
            const wIdx = widthList.indexOf(currentLineWidth);
            if (wIdx !== -1) widthIndex = wIdx;
          }
          if (msg.initialFilter !== undefined) {
            currentFilter = msg.initialFilter;
            pageWrapper.className = currentFilter ? 'filter-' + currentFilter : '';
          }

          pageDoodles.clear();
          pageHasDoodles.clear();
          undoStacks.clear();
          if (msg.initialDoodles) {
            for (const [p, d] of Object.entries(msg.initialDoodles)) {
              const pageNum = parseInt(p);
              if (d) {
                pageDoodles.set(pageNum, d);
                pageHasDoodles.add(pageNum);
              }
            }
          }
          notifyState();
          await renderPage(currentPageNum);
        } catch (err) {
          console.error('PDF Parse Error:', err);
          alert('PDF加载失败: ' + err.message);
        }
      } else if (msg.type === 'control') {
        handleControlAction(msg);
      }
    });

    function handleControlAction(msg) {
      switch(msg.action) {
        case 'prevPage': prevPage(); break;
        case 'nextPage': nextPage(); break;
        case 'setPage':
          if (msg.page >= 1 && msg.page <= totalPages) {
            currentPageNum = msg.page;
            renderPage(currentPageNum);
          }
          break;
        case 'setTool':
          currentTool = msg.tool;
          notifyState();
          break;
        case 'cycleColor':
          colorIndex = (colorIndex + 1) % colorList.length;
          currentColor = colorList[colorIndex];
          if (currentTool === 'eraser') currentTool = 'pen';
          notifyState();
          break;
        case 'cycleWidth':
          widthIndex = (widthIndex + 1) % widthList.length;
          currentLineWidth = widthList[widthIndex];
          notifyState();
          break;
        case 'undo': undo(); break;
        case 'toggleDark':
          currentFilter = currentFilter === 'dark-ide' ? '' : 'dark-ide';
          pageWrapper.className = currentFilter ? 'filter-' + currentFilter : '';
          notifyState();
          break;
        case 'save': triggerSave(); break;
      }
    }

    function zoomChange(delta, mousePos) {
      if (!pdfDoc) return;
      const oldScale = currentScale;
      const newScale = Math.max(0.5, Math.min(3.0, parseFloat((currentScale + delta).toFixed(2))));
      if (newScale === oldScale) return;
      currentScale = newScale;

      const vp = document.getElementById('main-viewport');
      if (mousePos && vp) {
        const rect = vp.getBoundingClientRect();
        const mouseX = mousePos.clientX - rect.left;
        const mouseY = mousePos.clientY - rect.top;
        const prevScrollLeft = vp.scrollLeft;
        const prevScrollTop = vp.scrollTop;
        const ratio = newScale / oldScale;

        renderPage(currentPageNum).then(() => {
          vp.scrollLeft = (prevScrollLeft + mouseX) * ratio - mouseX;
          vp.scrollTop = (prevScrollTop + mouseY) * ratio - mouseY;
        });
      } else {
        renderPage(currentPageNum);
      }
    }

    async function renderPage(num) {
      if (!pdfDoc) return;
      if (isRendering) {
        pendingRender = true;
        if (currentRenderTask) {
          try { currentRenderTask.cancel(); } catch (e) {}
        }
        return;
      }
      isRendering = true;
      saveCurrentPageDrawing();

      try {
        const page = await pdfDoc.getPage(num);
        const viewport = page.getViewport({ scale: currentScale });
        const dpr = window.devicePixelRatio || 1;

        pageWrapper.style.width = viewport.width + 'px';
        pageWrapper.style.height = viewport.height + 'px';

        pdfCanvas.width = viewport.width * dpr;
        pdfCanvas.height = viewport.height * dpr;
        pdfCanvas.style.width = viewport.width + 'px';
        pdfCanvas.style.height = viewport.height + 'px';
        pdfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        drawCanvas.width = viewport.width * dpr;
        drawCanvas.height = viewport.height * dpr;
        drawCanvas.style.width = viewport.width + 'px';
        drawCanvas.style.height = viewport.height + 'px';
        drawCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

        currentRenderTask = page.render({ canvasContext: pdfCtx, viewport: viewport });
        await currentRenderTask.promise;
        restorePageDrawing(num, viewport.width, viewport.height);
        notifyState();
      } catch (err) {
        if (err && (err.name === 'RenderingCancelledException' || err.message === 'Rendering cancelled')) {
          // 渲染取消正常忽略
        } else {
          console.error('Render error:', err);
        }
      } finally {
        isRendering = false;
        currentRenderTask = null;
        if (pendingRender) {
          pendingRender = false;
          renderPage(currentPageNum);
        }
      }
    }

    function saveCurrentPageDrawing() {
      if (!isDrawingDirty || !drawCanvas.width) return;
      const dataUrl = drawCanvas.toDataURL('image/png');
      pageDoodles.set(currentPageNum, dataUrl);
      pageHasDoodles.add(currentPageNum);
      isDrawingDirty = false;

      vscode.postMessage({
        type: 'autoSaveDoodle',
        page: currentPageNum,
        doodle: dataUrl
      });
    }

    function restorePageDrawing(num, width, height) {
      drawCtx.clearRect(0, 0, width, height);
      if (pageDoodles.has(num)) {
        const img = new Image();
        img.onload = () => {
          drawCtx.drawImage(img, 0, 0, width, height);
          isDrawingDirty = false;
        };
        img.src = pageDoodles.get(num);
      }
    }

    function pushUndoSnapshot() {
      if (!undoStacks.has(currentPageNum)) undoStacks.set(currentPageNum, []);
      const stack = undoStacks.get(currentPageNum);
      if (stack.length > 30) stack.shift();
      stack.push(drawCanvas.toDataURL('image/png'));
    }

    function undo() {
      const stack = undoStacks.get(currentPageNum);
      const dpr = window.devicePixelRatio || 1;
      const w = drawCanvas.width / dpr;
      const h = drawCanvas.height / dpr;

      if (!stack || stack.length === 0) {
        drawCtx.clearRect(0, 0, w, h);
        pageDoodles.delete(currentPageNum);
        pageHasDoodles.delete(currentPageNum);
        isDrawingDirty = false;
        vscode.postMessage({
          type: 'autoSaveDoodle',
          page: currentPageNum,
          doodle: null
        });
        return;
      }
      const prev = stack.pop();
      const img = new Image();
      img.onload = () => {
        drawCtx.clearRect(0, 0, w, h);
        drawCtx.drawImage(img, 0, 0, w, h);
        const dataUrl = drawCanvas.toDataURL('image/png');
        pageDoodles.set(currentPageNum, dataUrl);
        pageHasDoodles.add(currentPageNum);
        isDrawingDirty = false;
        vscode.postMessage({
          type: 'autoSaveDoodle',
          page: currentPageNum,
          doodle: dataUrl
        });
      };
      img.src = prev;
    }

    function prevPage() {
      if (currentPageNum <= 1) return;
      currentPageNum--;
      renderPage(currentPageNum);
    }
    function nextPage() {
      if (currentPageNum >= totalPages) return;
      currentPageNum++;
      renderPage(currentPageNum);
    }

    drawCanvas.addEventListener('pointerdown', (e) => {
      drawCanvas.setPointerCapture(e.pointerId);
      isDrawing = true;
      isDrawingDirty = true;
      pushUndoSnapshot();
      pageHasDoodles.add(currentPageNum);

      const rect = drawCanvas.getBoundingClientRect();
      lastX = e.clientX - rect.left;
      lastY = e.clientY - rect.top;
    });

    drawCanvas.addEventListener('pointermove', (e) => {
      if (!isDrawing) return;
      const rect = drawCanvas.getBoundingClientRect();
      const currentX = e.clientX - rect.left;
      const currentY = e.clientY - rect.top;

      drawCtx.save();
      drawCtx.lineCap = 'round';
      drawCtx.lineJoin = 'round';

      if (currentTool === 'eraser') {
        drawCtx.globalCompositeOperation = 'destination-out';
        drawCtx.lineWidth = Math.max(8, currentLineWidth * 5);
        drawCtx.beginPath();
        drawCtx.moveTo(lastX, lastY);
        drawCtx.lineTo(currentX, currentY);
        drawCtx.stroke();
      } else if (currentTool === 'highlighter') {
        drawCtx.globalCompositeOperation = 'source-over';
        drawCtx.globalAlpha = 0.35;
        drawCtx.strokeStyle = '#ffe066';
        drawCtx.lineWidth = Math.max(10, currentLineWidth * 5);
        drawCtx.beginPath();
        drawCtx.moveTo(lastX, lastY);
        drawCtx.lineTo(currentX, currentY);
        drawCtx.stroke();
      } else {
        drawCtx.globalCompositeOperation = 'source-over';
        drawCtx.globalAlpha = 1.0;
        drawCtx.strokeStyle = currentColor;
        drawCtx.lineWidth = currentLineWidth;
        drawCtx.beginPath();
        drawCtx.moveTo(lastX, lastY);
        drawCtx.lineTo(currentX, currentY);
        drawCtx.stroke();
      }
      drawCtx.restore();
      lastX = currentX;
      lastY = currentY;
    });

    function endStroke(e) {
      if (isDrawing) {
        isDrawing = false;
        try { drawCanvas.releasePointerCapture(e.pointerId); } catch(err) {}
        saveCurrentPageDrawing();
      }
    }
    drawCanvas.addEventListener('pointerup', endStroke);
    drawCanvas.addEventListener('pointercancel', endStroke);

    function triggerSave() {
      saveCurrentPageDrawing();
      const doodlesObj = {};
      for (const [p, d] of pageDoodles.entries()) {
        if (pageHasDoodles.has(p) && d) {
          doodlesObj[p] = d;
        }
      }
      vscode.postMessage({
        type: 'savePdf',
        doodles: doodlesObj
      });
    }

    // 快捷键支持
    window.addEventListener('keydown', (e) => {
      // 老板键：按 Esc 或反引号直接跳转到工程其他文件！
      if (e.key === 'Escape' || e.code === 'Backquote') {
        e.preventDefault();
        vscode.postMessage({ type: 'bossJump' });
        return;
      }

      if (e.target.tagName !== 'INPUT') {
        if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A' || e.key === 'PageUp') {
          prevPage();
        } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === 'PageDown') {
          nextPage();
        } else if (e.key === '1') {
          currentTool = 'pen';
          notifyState();
        } else if (e.key === '2') {
          currentTool = 'highlighter';
          notifyState();
        } else if (e.key === '3') {
          currentTool = 'eraser';
          notifyState();
        } else if (e.key === '[') {
          // 减细粗细，最小 1px
          currentLineWidth = Math.max(1, currentLineWidth - 1);
          notifyState();
        } else if (e.key === ']') {
          // 增粗粗细
          currentLineWidth = Math.min(10, currentLineWidth + 1);
          notifyState();
        } else if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          undo();
        } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          triggerSave();
        }
      }
    });

    // Ctrl + 滚轮缩放支持
    window.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (!pdfDoc) return;
        const delta = e.deltaY < 0 ? 0.1 : -0.1;
        zoomChange(delta, { clientX: e.clientX, clientY: e.clientY });
      }
    }, { passive: false });

    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

module.exports = {
  activate,
  deactivate: () => hideEditorStatusItems()
};
