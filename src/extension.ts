import * as vscode from 'vscode'
import { scanProject } from './scanner'
import { loadFlow, refreshFlow } from './flow-loader'
import { analyzeCode, cancelPendingAI, applyCheckingState } from './aiChecker'
import { ProjectInfo, ProjectProgress, StepProgress } from './types'

const FLOW_SERVER = 'https://itk-extension.vercel.app'

// ─────────────────────────────────────────────────────────────
//  PROGRESS
// ─────────────────────────────────────────────────────────────
function progressKey(rootPath: string, service: string, feature: string): string {
  const pid = Buffer.from(rootPath).toString('base64').slice(0, 16)
  return `itk_progress_${pid}_${service}_${feature}`
}

// Read cached AI analysis result without triggering a new analysis
async function loadCachedAnalysis(
  ctx: vscode.ExtensionContext,
  project: any,
  service: string,
  feature: string
): Promise<any | null> {
  const pid = project.rootPath.slice(-20).replace(/\W/g,'')
  const key = `itk_analysis_${pid}_${project.framework}_${service}_${feature}`
  const cached = ctx.workspaceState.get<any>(key)
  return cached?.result ?? null
}

function skipKey(rootPath: string, service: string, feature: string): string {
  const pid = Buffer.from(rootPath).toString('base64').slice(0, 16)
  return `itk_skipped_${pid}_${service}_${feature}`
}

function loadSkipped(ctx: vscode.ExtensionContext, rootPath: string, service: string, feature: string): Record<string, boolean> {
  return ctx.workspaceState.get(skipKey(rootPath, service, feature)) ?? {}
}

async function saveSkipped(ctx: vscode.ExtensionContext, rootPath: string, service: string, feature: string, skipped: Record<string, boolean>): Promise<void> {
  await ctx.workspaceState.update(skipKey(rootPath, service, feature), skipped)
}

function loadProgress(ctx: vscode.ExtensionContext, rootPath: string, service: string, feature: string): ProjectProgress {
  return ctx.workspaceState.get(progressKey(rootPath, service, feature)) ?? {}
}

async function saveProgress(ctx: vscode.ExtensionContext, rootPath: string, service: string, feature: string, progress: ProjectProgress): Promise<void> {
  await ctx.workspaceState.update(progressKey(rootPath, service, feature), progress)
}

// ─────────────────────────────────────────────────────────────
//  FETCH SERVICES
// ─────────────────────────────────────────────────────────────
async function fetchServices(): Promise<any[]> {
  try {
    const res = await fetch(`${FLOW_SERVER}/flows/services.json`)
    if (!res.ok) { throw new Error(`HTTP ${res.status}`) }
    const data = await res.json() as any
    return data.services ?? []
  } catch {
    return [{
      id: 'stripe', name: 'Stripe', description: 'Payments and subscriptions',
      icon: 'stripe', color: '#635BFF', bg: '#1a1640', free: true,
      features: [{ id: 'subscription', label: 'Monthly subscription', steps: 3 }]
    }]
  }
}

// ─────────────────────────────────────────────────────────────
//  ACTIVATE
// ─────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {

  // Resolve media URIs once — used in every screen that renders service logos
  const mediaUri = (panel: vscode.WebviewPanel | vscode.WebviewView, file: string) => {
    const diskPath = vscode.Uri.joinPath(context.extensionUri, 'media', file)
    return 'webview' in panel
      ? (panel as vscode.WebviewPanel).webview.asWebviewUri(diskPath).toString()
      : (panel as vscode.WebviewView).webview.asWebviewUri(diskPath).toString()
  }

  const clearCmd = vscode.commands.registerCommand('itk.clearCache', async () => {
    for (const key of context.workspaceState.keys()) {
      await context.workspaceState.update(key, undefined)
    }
    for (const key of context.globalState.keys()) {
      await context.globalState.update(key, undefined)
    }
    vscode.window.showInformationMessage('ITK: All cache cleared')
  })
  context.subscriptions.push(clearCmd)

  const provider = new ITKViewProvider(context)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('itk.view', provider)
  )

  const cmd = vscode.commands.registerCommand('itk.open', async () => {
    const project = await scanProject(context)
    if (!project) { return }

    const panel = vscode.window.createWebviewPanel(
      'itk', 'ITK',
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')]
      }
    )

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png')

    // Build a map of service id → resolved webview image URI
    // We do this once after the panel is created so asWebviewUri is available
    const imageUriMap = (serviceId: string): string => {
      const diskPath = vscode.Uri.joinPath(context.extensionUri, 'media', `${serviceId}.png`)
      return panel.webview.asWebviewUri(diskPath).toString()
    }

    let currentService: any    = null
    let currentFeature: string = ''
    let currentFlow: any       = null
    let codeAnalysis: any      = null

    // Debug log — accumulated and rendered in the webview popover
    const dbg: string[] = []
    function log(msg: string) {
      const ts = new Date().toISOString().slice(11, 23)
      dbg.push(`[${ts}] ${msg}`)
      if (dbg.length > 60) { dbg.shift() }
    }
    function refreshDebug() {
      // Re-render current screen with latest logs if we are on the integration screen
      if (!currentFlow || !currentService || !currentFeature) { return }
      // Patch just the debug panel content without rebuilding the whole page
      panel.webview.postMessage({ type: '_debugUpdate', logs: dbg })
    }

    panel.webview.html = loadingScreen('Detecting your project...')

    // Wipe all stale AI analysis cache on every panel open
    for (const key of context.workspaceState.keys()) {
      if (key.startsWith('itk_analysis_')) {
        await context.workspaceState.update(key, undefined)
      }
    }

    // scanProject auto-detects the project root — walks subdirectories if needed
    const detectedProject = await scanProject(context)
    if (!detectedProject) { return }

    const services = await fetchServices()
    panel.webview.html = buildServicePicker(detectedProject, services, imageUriMap)

    // File watcher — only updates the live badge, no auto-analysis
    const watcher = vscode.workspace.onDidSaveTextDocument(async () => {
      // No auto-analysis on save — user clicks Check my code manually
    })

    panel.onDidDispose(() => watcher.dispose())
    context.subscriptions.push(watcher)

    // Use detectedProject as the authoritative project throughout the panel session
    let activeProject = detectedProject

    panel.webview.onDidReceiveMessage(async msg => {

      if (msg.type === 'selectService') {
        currentService = services.find((s: any) => s.id === msg.serviceId)
        if (!currentService) { return }
        panel.webview.html = buildFeaturePicker(activeProject, currentService, imageUriMap)
      }

      if (msg.type === 'backToServices') {
        cancelPendingAI()
        currentService = null; currentFeature = ''; currentFlow = null; codeAnalysis = null
        const freshProject = await scanProject(context)
        if (freshProject) { activeProject = freshProject }
        panel.webview.html = buildServicePicker(activeProject, services, imageUriMap)
      }

      if (msg.type === 'selectFeature') {
        currentFeature = msg.featureId
        panel.webview.html = loadingScreen('Loading steps...')

        try {
          const scanned = await scanProject(context)
          // Never copy stale framework from old project — show ... until properly detected
          const freshProject = scanned ?? project
          log(`selectFeature: ${currentService.id}/${currentFeature}`); refreshDebug()
          log(`rootPath: ${freshProject.rootPath}`); refreshDebug()
          log(`framework: ${freshProject.framework} | language: ${freshProject.language}`); refreshDebug()
          if (freshProject.framework === 'unknown') {
            log(`WARNING: framework still unknown — analyzeCode may skip`); refreshDebug()
          }

          const flow = await loadFlow(context, freshProject, currentService.id, currentFeature)
          if (!flow) {
            log(`loadFlow returned null — aborting`); refreshDebug()
            return
          }
          log(`flow loaded OK, components: ${flow.code?.components?.length ?? 0}`); refreshDebug()
          currentFlow = flow

          const progress   = loadProgress(context, freshProject.rootPath, currentService.id, currentFeature)
          const initSkipped = loadSkipped(context, freshProject.rootPath, currentService.id, currentFeature)

          // Load previous cached result — only if flow has code check
          if (!flow.skipCodeCheck) {
            const cachedResult = await loadCachedAnalysis(context, freshProject, currentService.id, currentFeature)
            if (cachedResult) { codeAnalysis = cachedResult }
          }

          panel.webview.html = buildIntegrationScreen(
            freshProject, flow, codeAnalysis, progress, currentService, currentFeature, dbg, initSkipped
          )
          log(`UI rendered — cached analysis: ${codeAnalysis ? 'yes' : 'none'}`); refreshDebug()

        } catch(e: any) {
          log(`selectFeature ERROR: ${e.message}`); refreshDebug()
          log(`stack: ${e.stack}`); refreshDebug()
          vscode.window.showErrorMessage(`ITK: ${e.message}`)
        }
      }

      if (msg.type === 'backToFeatures') {
        cancelPendingAI()
        currentFeature = ''; currentFlow = null; codeAnalysis = null
        panel.webview.html = buildFeaturePicker(activeProject, currentService, imageUriMap)
      }

      if (msg.type === 'setFramework') {
        // Legacy handler — handled by switchFramework now
      }

      if (msg.type === 'clearFramework') {
        // User clicked "change" — clear override and re-detect
        const { clearManualOverride } = require('./scanner')
        await clearManualOverride(context, project.rootPath)
        if (currentFlow && currentService && currentFeature) {
          const updated = await scanProject(context)
          if (!updated) { return }
          const progress = loadProgress(context, updated.rootPath, currentService.id, currentFeature)
          panel.webview.html = buildIntegrationScreen(
            updated, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg
          )
        }
      }

      if (msg.type === 'switchFramework') {
        if (!currentFlow || !currentService || !currentFeature) { return }
        const { saveManualOverride } = require('./scanner')
        const langMap: Record<string, string> = {
          nextjs: 'typescript', react: 'javascript', nuxt: 'typescript',
          express: 'javascript', laravel: 'php', django: 'python',
          fastapi: 'python', flask: 'python', rails: 'ruby',
          go: 'go', springboot: 'java', rust: 'rust', unknown: 'unknown'
        }
        const lang = langMap[msg.framework] ?? 'unknown'
        await saveManualOverride(context, activeProject.rootPath, msg.framework, lang)
        activeProject.framework    = msg.framework as any
        activeProject.language     = lang as any
        activeProject.detectionSource = 'manual' as any

        // Load cached result for this framework — no auto-analyze
        const cachedForFw = await loadCachedAnalysis(context, activeProject, currentService.id, currentFeature)
        codeAnalysis = cachedForFw ?? null

        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        const skpd     = loadSkipped(context, activeProject.rootPath, currentService.id, currentFeature)
        panel.webview.html = buildIntegrationScreen(
          activeProject, currentFlow, codeAnalysis,
          progress, currentService, currentFeature, dbg, skpd
        )
      }

      if (msg.type === 'skipComponent') {
        if (!currentService || !currentFeature) { return }
        const skipped = loadSkipped(context, activeProject.rootPath, currentService.id, currentFeature)
        skipped[msg.componentId] = true
        await saveSkipped(context, activeProject.rootPath, currentService.id, currentFeature, skipped)
        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        panel.webview.html = buildIntegrationScreen(activeProject, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg, skipped)
      }

      if (msg.type === 'unskipComponent') {
        if (!currentService || !currentFeature) { return }
        const skipped = loadSkipped(context, activeProject.rootPath, currentService.id, currentFeature)
        delete skipped[msg.componentId]
        await saveSkipped(context, activeProject.rootPath, currentService.id, currentFeature, skipped)
        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        panel.webview.html = buildIntegrationScreen(activeProject, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg, skipped)
      }

      if (msg.type === 'checkCode') {
        if (!currentFlow || !currentService || !currentFeature) { return }
        if (currentFlow.skipCodeCheck) { return }

        // Show spinner immediately
        const skpd0    = loadSkipped(context, activeProject.rootPath, currentService.id, currentFeature)
        const progress0 = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        panel.webview.html = buildIntegrationScreen(
          activeProject, currentFlow, null, progress0, currentService, currentFeature, dbg, skpd0, true
        )

        const updated = await scanProject(context)
        if (!updated) { return }
        activeProject = updated

        analyzeCode(
          context, activeProject, currentFlow,
          currentService.id, currentFeature,
          (analysis, updatedProject) => {
            codeAnalysis = analysis
            const prog = loadProgress(context, updatedProject.rootPath, currentService.id, currentFeature)
            const skpd = loadSkipped(context, updatedProject.rootPath, currentService.id, currentFeature)
            panel.webview.html = buildIntegrationScreen(
              updatedProject, currentFlow, codeAnalysis,
              prog, currentService, currentFeature, dbg, skpd
            )
          },
          false // force=true — always re-run on manual check
        )
      }

      if (msg.type === 'confirmDashboard') {
        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        progress['dashboard'] = { stepId: 'dashboard', confirmedByUser: true, confirmedAt: new Date().toISOString(), note: 'Confirmed' }
        await saveProgress(context, project.rootPath, currentService.id, currentFeature, progress)
        if (currentFlow) {
          panel.webview.html = buildIntegrationScreen(activeProject, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg)
        }
      }

      if (msg.type === 'confirmTerminal') {
        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        progress['terminal'] = { stepId: 'terminal', confirmedByUser: true, confirmedAt: new Date().toISOString(), note: 'Confirmed' }
        await saveProgress(context, project.rootPath, currentService.id, currentFeature, progress)
        if (currentFlow) {
          panel.webview.html = buildIntegrationScreen(activeProject, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg)
        }
      }

      if (msg.type === 'undoConfirm') {
        const progress = loadProgress(context, activeProject.rootPath, currentService.id, currentFeature)
        delete progress[msg.section]
        await saveProgress(context, project.rootPath, currentService.id, currentFeature, progress)
        if (currentFlow) {
          panel.webview.html = buildIntegrationScreen(activeProject, currentFlow, codeAnalysis, progress, currentService, currentFeature, dbg)
        }
      }

      if (msg.type === 'jumpToFile') {
        const fp = msg.file.startsWith('/') ? msg.file : `${activeProject.rootPath}/${msg.file}`
        try {
          const doc = await vscode.workspace.openTextDocument(fp)
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preserveFocus: false })
        } catch {
          vscode.window.showWarningMessage(`ITK: File not found — ${msg.file}`)
        }
      }

      if (msg.type === 'openUrl') { vscode.env.openExternal(vscode.Uri.parse(msg.url)) }
      if (msg.type === 'copy') {
        await vscode.env.clipboard.writeText(msg.text)
        vscode.window.showInformationMessage('ITK: Copied.')
      }
    })
  })

  context.subscriptions.push(cmd)
}

export function deactivate() {}

// ─────────────────────────────────────────────────────────────
//  CSS
// ─────────────────────────────────────────────────────────────
function css(): string {
  return `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #1e1e1e; color: #ccc; font-size: 13px; padding: 20px; line-height: 1.5; }
    h1 { color: #fff; font-size: 16px; font-weight: 500; margin-bottom: 2px; }
    h2 { color: #fff; font-size: 14px; font-weight: 500; }
    .meta { color: #888; font-size: 11px; margin-bottom: 16px; }
    .detected { display: inline-flex; align-items: center; gap: 6px; background: #0d2d1f; border-radius: 4px; padding: 3px 10px; font-size: 11px; color: #4ec9b0; margin-bottom: 20px; }
    .search-wrap { position: relative; margin-bottom: 16px; }
    .search-input { width: 100%; background: #252526; border: 0.5px solid #3c3c3c; border-radius: 6px; color: #ccc; font-size: 13px; padding: 8px 12px 8px 32px; font-family: inherit; outline: none; }
    .search-input:focus { border-color: #0078d4; }
    .search-icon { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: #888; font-size: 14px; }

    /* Service grid — 3 columns */
    .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }

    /* Service card — logo centred, badge pinned bottom-right */
    .service-card {
      background: #252526;
      border: 0.5px solid #3c3c3c;
      border-radius: 8px;
      padding: 20px 10px;
      cursor: pointer;
      transition: border-color .15s, background .15s;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      position: relative;
      min-height: 100px;
    }
    .service-card:hover { border-color: #0078d4; background: #2a2d2e; }

    /* Logo container — fixed size, centred */
    .svc-logo-wrap {
      width: 72px;
      height: 72px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex-shrink: 0;
    }
    .svc-logo-wrap img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    /* Fallback emoji shown when no image is available */
    .svc-logo-emoji { font-size: 38px; line-height: 1; }

    /* Badge pinned to bottom-right corner of the card */
    .svc-badge {
      position: absolute;
      bottom: 6px;
      right: 8px;
      font-size: 9px;
      padding: 1px 6px;
      border-radius: 8px;
    }
    .badge-free { background: #0d2d1f; color: #4ec9b0; }
    .badge-paid { background: #2d2700; color: #dcdcaa; }

    .btn { border: none; padding: 6px 14px; border-radius: 4px; font-size: 11px; cursor: pointer; font-family: inherit; transition: opacity .15s; }
    .btn:hover { opacity: .85; }
    .btn-back { background: transparent; color: #888; border: 0.5px solid #3c3c3c; }
    .btn-secondary { background: #3c3c3c; color: #ccc; }
    .btn-confirm { background: #1a5c3a; color: #4ec9b0; }
    .btn-undo { background: #2d2700; color: #dcdcaa; font-size: 10px; padding: 3px 8px; }
    .btn-check { background: #0078d4; color: #fff; }
    .btn-check:disabled { background: #2a3a4a; color: #4a6a8a; cursor: not-allowed; opacity: 1; }

    /* Feature card — logo left, text right */
    .feature-card {
      background: #252526;
      border: 0.5px solid #3c3c3c;
      border-radius: 8px;
      padding: 12px 14px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 6px;
      transition: border-color .15s, background .15s;
    }
    .feature-card:hover { border-color: #0078d4; background: #2a2d2e; }

    /* Feature logo — slightly smaller than service card */
    .feature-logo-wrap {
      width: 36px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      flex-shrink: 0;
    }
    .feature-logo-wrap img { width: 100%; height: 100%; object-fit: contain; }
    .feature-logo-emoji { font-size: 18px; line-height: 1; }

    .f-info { flex: 1; }
    .f-title { font-size: 12px; font-weight: 500; color: #ccc; }
    .f-steps { font-size: 10px; color: #555; margin-top: 2px; }

    .section-card { background: #252526; border: 0.5px solid #3c3c3c; border-radius: 8px; margin-bottom: 10px; overflow: hidden; }
    .section-card.done { border-color: #1a5c3a; }
    .section-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; user-select: none; }
    .section-head:hover { background: #2a2d2e; }
    .section-icon { font-size: 16px; width: 24px; text-align: center; flex-shrink: 0; }
    .section-title { flex: 1; font-size: 13px; font-weight: 500; color: #fff; }
    .section-status { font-size: 10px; padding: 2px 8px; border-radius: 8px; }
    .status-done     { background: #0d3027; color: #4ec9b0; }
    .status-pending  { background: #2a2a2a; color: #666; }
    .status-checking { background: #0d1a2d; color: #9cdcfe; }
    .section-body { padding: 14px; border-top: 0.5px solid #3c3c3c; display: none; }
    .section-body.open { display: block; }
    .why-text { font-size: 11px; color: #888; line-height: 1.5; margin-bottom: 12px; }
    .step-item { margin-bottom: 14px; padding-bottom: 14px; border-bottom: 0.5px solid #2a2a2a; }
    .step-item:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .step-label { font-size: 12px; font-weight: 500; color: #ccc; margin-bottom: 6px; }
    .inst-list { margin: 6px 0 8px 16px; }
    .inst-list li { font-size: 11px; color: #999; line-height: 1.8; }
    .cmd-row { display: flex; align-items: center; gap: 8px; background: #0d0d1a; border-radius: 4px; padding: 7px 10px; margin-bottom: 4px; font-family: 'Courier New', monospace; font-size: 11px; color: #9cdcfe; }
    .cmd-row span { flex: 1; word-break: break-all; }
    .copy-btn { background: #3c3c3c; color: #ccc; border: none; padding: 2px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; flex-shrink: 0; font-family: inherit; }
    .copy-btn:hover { background: #555; }
    .success-looks { background: #081408; border-left: 2px solid #4ec9b0; padding: 6px 10px; border-radius: 0 4px 4px 0; font-size: 11px; color: #4ec9b0; margin-top: 6px; }
    .env-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 10px; }
    .env-item { background: #1a1a2e; border-radius: 4px; padding: 8px 10px; }
    .env-key { font-family: 'Courier New', monospace; font-size: 11px; color: #dcdcaa; margin-bottom: 2px; }
    .env-desc { font-size: 10px; color: #888; line-height: 1.4; }
    .env-server { font-size: 9px; color: #f44747; margin-top: 2px; }
    .confirm-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; padding-top: 12px; border-top: 0.5px solid #2a2a2a; }
    .confirm-note { font-size: 10px; color: #555; font-style: italic; }
    .code-section { }
    .component-item { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 0.5px solid #2a2a2a; }
    .component-item:last-child { border-bottom: none; }
    .component-label { font-size: 12px; font-weight: 500; color: #ccc; margin-bottom: 4px; }
    .component-desc { font-size: 11px; color: #888; line-height: 1.4; margin-bottom: 8px; }
    .code-wrap { position: relative; margin-bottom: 6px; }
    .code-block { background: #0d0d1a; border-radius: 4px; padding: 10px 40px 10px 12px; font-family: 'Courier New', monospace; font-size: 11px; color: #ce9178; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
    .code-copy-btn { position: absolute; top: 6px; right: 8px; background: #3c3c3c; color: #ccc; border: none; padding: 2px 8px; border-radius: 3px; font-size: 10px; cursor: pointer; }
    .analysis-result { margin-top: 14px; padding-top: 12px; border-top: 0.5px solid #2a2a2a; }
    .analysis-title { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 8px; }
    .analysis-item { border-radius: 4px; padding: 8px 10px; margin-bottom: 6px; font-size: 11px; line-height: 1.5; }
    .analysis-done    { background: #0d2d1f; border-left: 2px solid #4ec9b0; color: #9fe1cb; }
    .analysis-missing { background: #2d2700; border-left: 2px solid #dcdcaa; color: #dcdcaa; }
    .analysis-wrong   { background: #2d1010; border-left: 2px solid #f44747; color: #f88; }
    .analysis-item strong { display: block; margin-bottom: 2px; }
    .check-row { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
    .countdown { font-size: 10px; color: #555; }
    .checking-dots { display: inline-flex; gap: 3px; align-items: center; margin-left: 6px; }
    .checking-dots span { width: 4px; height: 4px; border-radius: 50%; background: #9cdcfe; animation: blink 1.2s ease-in-out infinite; }
    .checking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .checking-dots span:nth-child(3) { animation-delay: 0.4s; }
    .btn-help { 
    background: transparent; 
    border: 0.5px solid #3c3c3c; 
    color: #555; 
    width: 26px; 
    height: 26px; 
    border-radius: 50%; 
    font-size: 12px; 
    cursor: pointer; 
    font-family: inherit;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: border-color .15s, color .15s;
  }
  .btn-help:hover { border-color: #888; color: #ccc; }
  .top-bar { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    @keyframes blink { 0%,100%{opacity:.2} 50%{opacity:1} }
    .loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 200px; gap: 12px; color: #888; font-size: 12px; }
    .spinner { width: 24px; height: 24px; border: 2px solid #3c3c3c; border-top-color: #0078d4; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .live-badge { display: inline-flex; align-items: center; gap: 5px; font-size: 10px; color: #4ec9b0; margin-left: 10px; }
    .live-dot { width: 6px; height: 6px; border-radius: 50%; background: #4ec9b0; animation: pulse 2s ease-in-out infinite; }
    @keyframes pulse { 0%,100%{opacity:.3} 50%{opacity:.7} }
    .nav-row { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
    .btn-skip { background: transparent; color: #555; border: 0.5px solid #3c3c3c; font-size: 10px; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-family: inherit; }
    .btn-skip:hover { color: #888; border-color: #555; }
    .analysis-skipped { background: #1a1a1a; border-left: 2px solid #3c3c3c; color: #555; }
  `
}

// ─────────────────────────────────────────────────────────────
//  HELPERS — resolve logo HTML for a service
//  imageUriMap: (serviceId) => vscode-resource URI string | undefined
// ─────────────────────────────────────────────────────────────

/**
 * Returns the <div class="svc-logo-wrap"> block for a service card.
 * Uses the resolved webview URI for media/<id>.png when available.
 * Falls back to the emoji icon if the icon field is not 'stripe' / not a known id.
 */
function serviceLogoHtml(s: any, imageUri: string, size: 'large' | 'small' = 'large'): string {
  const wrapClass  = size === 'large' ? 'svc-logo-wrap'  : 'feature-logo-wrap'
  const emojiClass = size === 'large' ? 'svc-logo-emoji' : 'feature-logo-emoji'

  // logoBg:true  → white background box (for dark logos like AWS)
  // logoBg:false → transparent (logo floats on card background)
  // size=large (service list card) → bg controlled by card CSS, no inline bg needed
  // size=small (feature picker)    → bg box applied here so logo is visible on dark row
  const needsBg = s.logoBg === true  // apply white box on both large and small
  const bgStyle = needsBg ? 'background:#ffffff;border-radius:8px;padding:4px;' : ''

  // If icon field is a known service id (not an emoji), use the image
  const useImage = imageUri && s.icon && !/\p{Emoji}/u.test(s.icon)

  if (useImage) {
    return `<div class="${wrapClass}" style="${bgStyle}">
      <img src="${imageUri}" alt="${esc(s.name)} logo" />
    </div>`
  }

  // Fallback: emoji
  return `<div class="${wrapClass}" style="${bgStyle}">
    <span class="${emojiClass}">${esc(s.icon)}</span>
  </div>`
}

// ─────────────────────────────────────────────────────────────
//  LOADING
// ─────────────────────────────────────────────────────────────
function loadingScreen(msg = 'Loading...'): string {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${css()}</style></head>
<body><div class="loading"><div class="spinner"></div><span>${msg}</span></div></body></html>`
}

// ─────────────────────────────────────────────────────────────
//  SCREEN 1: SERVICE PICKER
// ─────────────────────────────────────────────────────────────
// <span class="svc-badge ${s.free ? 'badge-free' : 'badge-paid'}">${s.free ? 'free' : '$1/year'}</span>

function buildServicePicker(
  project: ProjectInfo,
  services: any[],
  imageUriMap: (id: string) => string
): string {
  const cards = services.map(s => {
    const imgUri = imageUriMap(s.id)
    const logo   = serviceLogoHtml(s, imgUri, 'large')
    // logoBg:true → tint the card with the service bg color so the logo is visible
    const cardBg = s.logoBg ? 'background:#ffffff;' : ''
    return `
    <div class="service-card"
         onclick="selectService('${s.id}')"
         data-name="${s.name.toLowerCase()}"
         data-desc="${s.description.toLowerCase()}"
         style="${cardBg}">
      ${logo}
    </div>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>${css()}</style></head>
<body>
<div class="top-bar">
  <div>
    <h1>ITK</h1>
    <p class="meta">Integration Toolkit — step-by-step API integration guide.</p>
  </div>
  <button class="btn-help" onclick="openHelp()" title="Help">?</button>
</div>
<div class="search-wrap">
  <span class="search-icon">⌕</span>
  <input class="search-input" placeholder="Search services..." oninput="filterServices(this.value)" autofocus>
</div>
<div class="grid" id="grid">${cards}</div>
<script>
const vscode = acquireVsCodeApi()
function selectService(id) { vscode.postMessage({ type: 'selectService', serviceId: id }) }
function filterServices(q) {
  q = q.toLowerCase()
  document.querySelectorAll('.service-card').forEach(c => {
    c.style.display = (c.dataset.name.includes(q) || c.dataset.desc.includes(q)) ? '' : 'none'
  })
}
function openHelp() { vscode.postMessage({ type: 'openUrl', url: 'https://itk-extension.vercel.app' }) }
</script></body></html>`
}

// ─────────────────────────────────────────────────────────────
//  SCREEN 2: FEATURE PICKER
// ─────────────────────────────────────────────────────────────
function buildFeaturePicker(
  project: ProjectInfo,
  service: any,
  imageUriMap: (id: string) => string
): string {
  const imgUri = imageUriMap(service.id)

  const features = service.features.map((f: any) => {
    const logo = serviceLogoHtml(service, imgUri, 'small')
    return `
    <div class="feature-card" onclick="selectFeature('${f.id}')">
      ${logo}
      <div class="f-info">
        <div class="f-title">${esc(f.label)}</div>
        <div class="f-steps">3 sections — Dashboard · Terminal · Code</div>
      </div>
      <div style="color:#555">→</div>
    </div>`
  }).join('')

  const headerLogo = serviceLogoHtml(service, imgUri, 'large')

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>${css()}</style></head>
<body>
<div class="nav-row" style="justify-content:space-between">
  <button class="btn btn-back" onclick="back()">← Back</button>
  <button class="btn-help" onclick="openHelp()" title="Help">?</button>
</div>
<div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
  ${headerLogo}
  <div>
    <p class="meta" style="margin-bottom:2px">${esc(service.description)}</p>

  </div>
</div>
<p style="font-size:11px;color:#888;margin-bottom:10px">What do you want to implement?</p>
${features}
<script>
const vscode = acquireVsCodeApi()
function back() { vscode.postMessage({ type: 'backToServices' }) }
function selectFeature(id) { vscode.postMessage({ type: 'selectFeature', featureId: id }) }
function openHelp() { vscode.postMessage({ type: 'openUrl', url: 'https://itk-extension.vercel.app' }) }
</script></body></html>`
}

// ─────────────────────────────────────────────────────────────
//  SCREEN 3: INTEGRATION (3 sections)
// ─────────────────────────────────────────────────────────────
function buildIntegrationScreen(
  project: ProjectInfo,
  flow: any,
  analysis: any,
  progress: ProjectProgress,
  service: any,
  featureId: string,
  debugLogs: string[] = [],
  skipped: Record<string, boolean> = {},
  isAnalyzing = false
): string {
  const feature       = service.features.find((f: any) => f.id === featureId)
  const dashDone      = !!progress['dashboard']?.confirmedByUser
  const termDone      = !!progress['terminal']?.confirmedByUser
  const framework     = project.framework

  // Merge persisted skips into analysis components
  if (analysis && Object.keys(skipped).length > 0) {
    analysis = {
      ...analysis,
      components: (analysis.components ?? []).map((comp: any) =>
        skipped[comp.id] ? { ...comp, status: 'skipped', note: 'Marked as not needed by user' } : comp
      ),
    }
    // Also inject skipped for components not yet in analysis
    const existingIds = new Set((analysis.components ?? []).map((c: any) => c.id))
    for (const compId of Object.keys(skipped)) {
      if (skipped[compId] && !existingIds.has(compId)) {
        analysis.components.push({ id: compId, status: 'skipped', note: 'Marked as not needed by user' })
      }
    }
    analysis.allDone = analysis.components.length > 0 &&
      analysis.components.every((c: any) => c.status === 'done' || c.status === 'skipped')
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><style>${css()}</style></head>
<body>

<div class="nav-row" style="justify-content:space-between">
  <button class="btn btn-back" onclick="back()">← Back</button>
  <button class="btn-help" onclick="openHelp()" title="Help">?</button>
</div>

<h1>${esc(service.name)} — ${esc(feature?.label ?? featureId)}</h1>
<div style="margin-bottom:16px">
  <span class="live-badge"><div class="live-dot"></div>Updates on file save</span>
</div>

${dashboardSection(flow.dashboard, dashDone)}
${terminalSection(flow.terminal, termDone, framework)}
${flow.skipCodeCheck ? '' : codeSection(flow.code, analysis, isAnalyzing, framework)}

<script>
const vscode = acquireVsCodeApi()
const state  = vscode.getState() || { openSections: ['dashboard', 'terminal', 'code'] }

state.openSections.forEach(id => {
  const b = document.getElementById('body-' + id)
  if (b) b.classList.add('open')
})

function toggleSection(id) {
  const b = document.getElementById('body-' + id)
  if (!b) { return }
  b.classList.toggle('open')
  const open = Array.from(document.querySelectorAll('.section-body.open')).map(el => el.id.replace('body-', ''))
  vscode.setState({ openSections: open })
}

function openHelp() { vscode.postMessage({ type: 'openUrl', url: 'https://itk-extension.vercel.app' }) }

function back()            { vscode.postMessage({ type: 'backToFeatures' }) }
function copy(t)           { vscode.postMessage({ type: 'copy', text: t }) }
function jump(f)           { vscode.postMessage({ type: 'jumpToFile', file: f }) }
function openUrl(u)        { vscode.postMessage({ type: 'openUrl', url: u }) }
function confirmDashboard(){ vscode.postMessage({ type: 'confirmDashboard' }) }
function confirmTerminal() { vscode.postMessage({ type: 'confirmTerminal' }) }
function undoConfirm(s)    { vscode.postMessage({ type: 'undoConfirm', section: s }) }
function clearFramework()  { vscode.postMessage({ type: 'clearFramework' }) }
function switchFramework(fw) { vscode.postMessage({ type: 'switchFramework', framework: fw }) }
function skipComponent(id)   { vscode.postMessage({ type: 'skipComponent', componentId: id }) }
function unskipComponent(id) { vscode.postMessage({ type: 'unskipComponent', componentId: id }) }
function confirmFramework() {
  const sel = document.getElementById('fw-picker')
  if (!sel || !sel.value) { return }
  const opt  = sel.options[sel.selectedIndex]
  const lang = opt.getAttribute('data-lang') || 'unknown'
  vscode.postMessage({ type: 'setFramework', framework: sel.value, language: lang })
}

let lastCheck = 0
const COOLDOWN = 5000

function checkCode() {
  const now = Date.now()
  const remaining = Math.ceil((COOLDOWN - (now - lastCheck)) / 1000)
  if (now - lastCheck < COOLDOWN) {
    alert('Please wait ' + remaining + ' seconds before checking again')
    return
  }
  lastCheck = now
  const btn = document.getElementById('check-btn')
  if (btn) {
    btn.disabled = true
    btn.textContent = 'Checking...'
    setTimeout(() => {
      btn.disabled = false
      btn.textContent = 'Check my code'
    }, COOLDOWN)
  }
  vscode.postMessage({ type: 'checkCode' })
}
</script>
</body></html>`
}

// ─────────────────────────────────────────────────────────────
//  DASHBOARD SECTION
// ─────────────────────────────────────────────────────────────
function dashboardSection(dashboard: any, isDone: boolean): string {
  if (!dashboard) { return '' }

  const steps = (dashboard.steps ?? []).map((s: any) => `
    <div class="step-item">
      <div class="step-label">${esc(s.label)}</div>
      <ul class="inst-list">
        ${(s.instructions ?? []).map((i: string) => `<li>${esc(i)}</li>`).join('')}
      </ul>
      ${s.successLooks ? `<div class="success-looks">✓ ${esc(s.successLooks)}</div>` : ''}
    </div>`).join('')

  const envItems = (dashboard.envKeys ?? []).map((k: any) => `
    <div class="env-item">
      <div class="env-key">${esc(k.key)}</div>
      <div class="env-desc">${esc(k.description)}</div>
      <div class="env-server">${k.serverOnly ? 'Server only — never expose to frontend' : '✓ Safe for frontend'}</div>
    </div>`).join('')

  return `
<div class="section-card ${isDone ? 'done' : ''}">
  <div class="section-head" onclick="toggleSection('dashboard')">
    <span class="section-title">Dashboard setup</span>
    <span class="section-status ${isDone ? 'status-done' : 'status-pending'}">${isDone ? '✓ done' : 'not started'}</span>
  </div>
  <div class="section-body open" id="body-dashboard">
    <p class="why-text">${esc(dashboard.why ?? '')}</p>
    ${steps}
    ${envItems.length > 0 ? `
    <div style="margin-top:12px">
      <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Credentials to add to .env</div>
      <div class="env-grid">${envItems}</div>
    </div>` : ''}
    <div class="confirm-row">
      ${isDone
        ? `<button class="btn btn-undo" onclick="undoConfirm('dashboard')">Undo</button>
           <span class="confirm-note">Marked as done</span>`
        : `<button class="btn btn-confirm" onclick="confirmDashboard()">I've done all dashboard steps ✓</button>`
      }
    </div>
  </div>
</div>`
}

// ─────────────────────────────────────────────────────────────
//  TERMINAL SECTION
// ─────────────────────────────────────────────────────────────
function terminalSection(terminal: any, isDone: boolean, framework: string): string {
  if (!terminal) { return '' }

  const steps = (terminal.steps ?? []).map((s: any) => {
    const cmds    = s.commands?.[framework] || s.commands?.all || s.commands?.mac || []
    const allCmds = s.commands?.all || []

    const cmdRows = [...cmds, ...allCmds.filter((c: any) =>
      !cmds.find((x: any) => x.value === c.value)
    )].map((cmd: any) => `
      <div class="cmd-block">
        <div class="cmd-label-row">
          <span class="cmd-label-text">${esc(cmd.label)}</span>
          <button class="copy-btn" onclick="copy('${escAttr(cmd.value)}')">Copy</button>
        </div>
        <div class="cmd-row">
          <span>${esc(cmd.value)}</span>
        </div>
      </div>`).join('')

    const instructions = (s.instructions ?? []).map((i: string) => `<li>${esc(i)}</li>`).join('')

    return `
    <div class="step-item">
      <div class="step-label">${esc(s.label)}</div>
      ${s.why ? `<div style="font-size:11px;color:#888;margin-bottom:6px">${esc(s.why)}</div>` : ''}
      ${instructions.length > 0 ? `<ul class="inst-list">${instructions}</ul>` : ''}
      ${cmdRows}
      ${s.successLooks ? `<div class="success-looks">✓ ${esc(s.successLooks)}</div>` : ''}
    </div>`
  }).join('')

  return `
<div class="section-card ${isDone ? 'done' : ''}">
  <div class="section-head" onclick="toggleSection('terminal')">
    <span class="section-title">Terminal setup</span>
    <span class="section-status ${isDone ? 'status-done' : 'status-pending'}">${isDone ? '✓ done' : 'not started'}</span>
  </div>
  <div class="section-body" id="body-terminal">
    <p class="why-text">${esc(terminal.why ?? '')}</p>
    ${steps}
    <div class="confirm-row">
      ${isDone
        ? `<button class="btn btn-undo" onclick="undoConfirm('terminal')">Undo</button>
           <span class="confirm-note">Marked as done</span>`
        : `<button class="btn btn-confirm" onclick="confirmTerminal()">I've run all terminal steps ✓</button>`
      }
    </div>
  </div>
</div>`
}

// ─────────────────────────────────────────────────────────────
//  CODE SECTION
// ─────────────────────────────────────────────────────────────
function codeSection(code: any, analysis: any, isAnalyzing: boolean, framework: string): string {

  const FRAMEWORKS = [
    { id: 'nextjs',     label: 'Next.js'     },
    { id: 'react',      label: 'React'        },
    { id: 'nuxt',       label: 'Nuxt'         },
    { id: 'express',    label: 'Express'      },
    { id: 'laravel',    label: 'Laravel'      },
    { id: 'django',     label: 'Django'       },
    { id: 'fastapi',    label: 'FastAPI'      },
    { id: 'flask',      label: 'Flask'        },
    { id: 'rails',      label: 'Rails'        },
    { id: 'go',         label: 'Go'           },
    { id: 'springboot', label: 'Spring Boot'  },
    { id: 'rust',       label: 'Rust'         },
  ]

  const fwOptions = FRAMEWORKS.map(f =>
    `<option value="${f.id}" ${f.id === framework ? 'selected' : ''}>${f.label}</option>`
  ).join('')

  const fwDropdown = `
    <select id="fw-select" onchange="switchFramework(this.value)"
      style="background:#1e1e1e;border:0.5px solid #3c3c3c;color:#ccc;font-size:11px;padding:4px 8px;border-radius:4px;font-family:inherit;outline:none;cursor:pointer">
      <option value="" disabled ${framework === 'unknown' ? 'selected' : ''}>Select framework...</option>
      ${fwOptions}
    </select>`

  // ── Status label ────────────────────────────────────────────
  const statusClass = isAnalyzing ? 'status-checking' : analysis?.allDone ? 'status-done' : analysis ? 'status-pending' : 'status-pending'
  const statusLabel = isAnalyzing ? 'analyzing...' : analysis?.allDone ? '✓ complete' : analysis ? 'review needed' : 'not checked'

  // ── Analyzing spinner ───────────────────────────────────────
  if (isAnalyzing) {
    return `
<div class="section-card">
  <div class="section-head" onclick="toggleSection('code')">
    <span class="section-title">Code</span>
    <span class="section-status status-checking">analyzing...</span>
  </div>
  <div class="section-body open" id="body-code">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
      ${fwDropdown}
      <button class="btn btn-check" disabled>Checking...</button>
    </div>
    <div style="display:flex;flex-direction:column;align-items:center;padding:32px 0;gap:12px">
      <div class="spinner"></div>
      <div style="font-size:12px;color:#888">Analyzing your code...</div>
    </div>
  </div>
</div>`
  }

  // ── Analysis result ─────────────────────────────────────────
  let resultHtml = ''
  if (analysis?.components?.length > 0) {
    const bullets = analysis.components.map((c: any) => {
      const icon    = c.status === 'done' ? '✓' : c.status === 'skipped' ? '—' : c.status === 'wrong' ? '⚠' : '○'
      const color   = c.status === 'done' ? '#4ec9b0' : c.status === 'skipped' ? '#444' : c.status === 'wrong' ? '#f44747' : '#dcdcaa'
      const skipBtn = (c.status === 'missing' || c.status === 'wrong')
        ? `<button class="btn-skip" onclick="skipComponent('${escAttr(c.id)}')">I don't need this</button>`
        : c.status === 'skipped'
        ? `<button class="btn-skip" onclick="unskipComponent('${escAttr(c.id)}')">Undo</button>`
        : ''
      return `<div style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px">
        <span style="color:${color};flex-shrink:0;margin-top:1px;font-size:12px">${icon}</span>
        <span style="color:#999;flex:1;font-size:11px;line-height:1.5">${esc(c.note)}</span>
        ${skipBtn}
      </div>`
    }).join('')

    resultHtml = `
    <div style="margin-top:14px;padding-top:12px;border-top:0.5px solid #2a2a2a">
      <div style="font-size:10px;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px">Analysis result</div>
      ${bullets}
    </div>`
  }

  // ── No result yet ───────────────────────────────────────────
  const emptyHtml = !analysis ? `
    <div style="font-size:11px;color:#555;font-style:italic;margin-top:8px">
      Select your framework and click Check my code to analyze your integration
    </div>` : ''

  return `
<div class="section-card">
  <div class="section-head" onclick="toggleSection('code')">
    <span class="section-title">Code</span>
    <span class="section-status ${statusClass}">${statusLabel}</span>
  </div>
  <div class="section-body" id="body-code">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
      ${fwDropdown}
      <button class="btn btn-check" id="check-btn" onclick="checkCode()">Check my code</button>
    </div>
    ${emptyHtml}
    ${resultHtml}
  </div>
</div>`
}


// ─────────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────────
function esc(s: any): string {
  if (!s) { return '' }
  if (typeof s !== 'string') { s = JSON.stringify(s) }
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
}
function escAttr(s: any): string {
  if (!s) { return '' }
  if (typeof s !== 'string') { s = JSON.stringify(s) }
  return s.replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/\n/g,'\\n').replace(/\r/g,'')
}

// ─────────────────────────────────────────────────────────────
//  SIDEBAR VIEW PROVIDER
// ─────────────────────────────────────────────────────────────
class ITKViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<style>
  body { font-family: -apple-system, sans-serif; padding: 16px; background: #1e1e1e; color: #ccc; font-size: 12px; }
  .btn { background: #0078d4; color: #fff; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer; font-size: 12px; width: 100%; font-family: inherit; }
  .btn:hover { background: #005fa3; }
  p { color: #888; font-size: 11px; line-height: 1.5; margin-bottom: 12px; }
</style>
</head>
<body>
<p>Integration Toolkit — step-by-step API integration guide.</p>
<button class="btn" onclick="open()">Open ITK</button>
<script>
const vscode = acquireVsCodeApi()
function open() { vscode.postMessage({ type: 'open' }) }
</script>
</body></html>`

    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'open') {
        vscode.commands.executeCommand('itk.open')
    }
    })
  }
}