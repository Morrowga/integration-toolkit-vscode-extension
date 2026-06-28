import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { ProjectInfo, Language, Framework, DetectionSource } from './types'

const FLOW_SERVER = 'https://itk-extension.vercel.app'

const SOURCE_EXTENSIONS = [
  '.ts','.tsx','.js','.jsx','.mjs',
  '.php','.py','.vue','.svelte','.rb','.go','.rs'
]

const IGNORE_DIRS = new Set([
  'node_modules','.git','.next','.nuxt','dist',
  'build','__pycache__','.venv','venv','vendor',
  '.cache','out','coverage','.svelte-kit'
])

// ── Walk directory ──────────────────────────────────────────
export function walkDir(dir: string, files: string[] = [], depth = 0): string[] {
  if (depth > 6 || !fs.existsSync(dir)) { return files }
  for (const entry of fs.readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) { continue }
    const full = path.join(dir, entry)
    try {
      const stat = fs.statSync(full)
      if (stat.isDirectory()) { walkDir(full, files, depth + 1) }
      else if (SOURCE_EXTENSIONS.some(e => entry.endsWith(e))) { files.push(full) }
    } catch {}
  }
  return files
}

// ── Read file safely ────────────────────────────────────────
export function readFile(fp: string): string {
  try { return fs.readFileSync(fp, 'utf8') } catch { return '' }
}

// ── Read .env key NAMES only — values never touched ─────────
function readEnvKeyNames(rootPath: string): string[] {
  const keyNames: string[] = []
  for (const envFile of ['.env','.env.local','.env.development','.env.example']) {
    const fp = path.join(rootPath, envFile)
    if (!fs.existsSync(fp)) { continue }
    for (const line of readFile(fp).split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) { continue }
      const keyName = trimmed.split('=')[0].trim()
      if (keyName && !keyNames.includes(keyName)) { keyNames.push(keyName) }
    }
  }
  return keyNames
}

// ── Read installed packages from ALL package files ──────────
// Returns combined list — Laravel has both composer.json AND package.json
function readInstalledPackages(rootPath: string): string[] {
  const all: string[] = []

  // JS — always read if present
  const pkgPath = path.join(rootPath, 'package.json')
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFile(pkgPath))
      const deps = { ...pkg.dependencies, ...pkg.devDependencies }
      all.push(...Object.keys(deps))
    } catch {}
  }

  // PHP — always read if present (Laravel has both package.json AND composer.json)
  const composerPath = path.join(rootPath, 'composer.json')
  if (fs.existsSync(composerPath)) {
    try {
      const c = JSON.parse(readFile(composerPath))
      all.push(...Object.keys(c.require || {}))
      all.push(...Object.keys(c['require-dev'] || {}))
    } catch {}
  }

  // Python — always read if present
  const reqPath = path.join(rootPath, 'requirements.txt')
  if (fs.existsSync(reqPath)) {
    const pyPkgs = readFile(reqPath)
      .split('\n')
      .map(l => l.trim().toLowerCase())
      .filter(l => l && !l.startsWith('#'))
    all.push(...pyPkgs)
  }

  return [...new Set(all)] // deduplicate
}

// ── Detect port from APP_URL only ───────────────────────────
function detectPort(rootPath: string): string {
  for (const envFile of ['.env','.env.local','.env.development']) {
    const fp = path.join(rootPath, envFile)
    if (!fs.existsSync(fp)) { continue }
    for (const line of readFile(fp).split('\n')) {
      const trimmed = line.trim()
      if (trimmed.startsWith('APP_URL=') || trimmed.startsWith('NEXT_PUBLIC_URL=')) {
        const match = trimmed.match(/:(\d+)/)
        if (match) { return match[1] }
      }
    }
  }
  return ''
}

// ── Scan for hardcoded secrets in source files ──────────────
export interface ScanIssue {
  file: string
  line: number
  message: string
  risk: string
}

function scanHardcodedKeys(contents: Record<string, string>): ScanIssue[] {
  const issues: ScanIssue[] = []
  const pattern = /['"](sk_live_|sk_test_)[a-zA-Z0-9]{20,}['"]/
  for (const [fp, content] of Object.entries(contents)) {
    content.split('\n').forEach((line, i) => {
      if (pattern.test(line)) {
        issues.push({
          file: path.basename(fp),
          line: i + 1,
          message: 'Stripe secret key hardcoded in source file',
          risk: 'Anyone with repo access can charge your Stripe account'
        })
      }
    })
  }
  return issues
}

// ── Validate step pattern ───────────────────────────────────
export function validateStep(
  scanPattern: string,
  contents: Record<string, string>
): 'done' | 'missing' {
  if (!scanPattern) { return 'missing' }
  try {
    const regex = new RegExp(scanPattern)
    return Object.values(contents).some(c => regex.test(c)) ? 'done' : 'missing'
  } catch { return 'missing' }
}

// ── Local framework detection (fast, no network) ────────────
function detectLocalFramework(rootPath: string, packages: string[]): { framework: Framework; language: Language } {
  const pkgSet = new Set(packages.map(p => p.toLowerCase()))

  const has = (filename: string) => fs.existsSync(path.join(rootPath, filename))

  // Check config files first — most reliable signal
  if (has('next.config.js') || has('next.config.ts') || has('next.config.mjs')) {
    return { framework: 'nextjs' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }
  if (has('nuxt.config.js') || has('nuxt.config.ts') || has('nuxt.config.mjs')) {
    return { framework: 'nuxt' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }
  if (has('artisan') && has('composer.json')) {
    return { framework: 'laravel' as Framework, language: 'php' as Language }
  }
  if (has('manage.py')) {
    return { framework: 'django' as Framework, language: 'python' as Language }
  }
  if (has('go.mod')) {
    return { framework: 'go' as Framework, language: 'go' as Language }
  }
  if (has('pom.xml') || has('build.gradle')) {
    return { framework: 'springboot' as Framework, language: 'java' as Language }
  }
  if (has('Cargo.toml')) {
    return { framework: 'rust' as Framework, language: 'rust' as Language }
  }

  // If artisan exists, it's Laravel regardless of what package.json says
  // Laravel projects have package.json (Vite/Mix) but artisan is the definitive signal
  if (has('artisan')) {
    return { framework: 'laravel' as Framework, language: 'php' as Language }
  }

  // Check installed packages
  if (pkgSet.has('fastapi') || packages.some(p => p.startsWith('fastapi'))) {
    return { framework: 'fastapi' as Framework, language: 'python' as Language }
  }
  if (pkgSet.has('flask')) {
    return { framework: 'flask' as Framework, language: 'python' as Language }
  }
  if (pkgSet.has('next')) {
    return { framework: 'nextjs' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }
  if (pkgSet.has('nuxt') || pkgSet.has('nuxt3')) {
    return { framework: 'nuxt' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }
  if (pkgSet.has('express')) {
    return { framework: 'express' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }
  if (pkgSet.has('react') || pkgSet.has('@vitejs/plugin-react')) {
    return { framework: 'react' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }

  // Gemfile = Ruby/Rails
  if (has('Gemfile')) {
    return { framework: 'rails' as Framework, language: 'ruby' as Language }
  }

  // Generic fallbacks by config file presence
  if (has('requirements.txt') || has('pyproject.toml') || has('Pipfile')) {
    return { framework: 'unknown' as Framework, language: 'python' as Language }
  }
  if (has('composer.json')) {
    return { framework: 'unknown' as Framework, language: 'php' as Language }
  }
  if (has('package.json')) {
    return { framework: 'unknown' as Framework, language: (has('tsconfig.json') ? 'typescript' : 'javascript') as Language }
  }

  return { framework: 'unknown' as Framework, language: 'unknown' as Language }
}

// ── Server-side detection fallback ──────────────────────────
async function detectFromServer(
  rootPath: string,
  files: string[],
  packages: string[]
): Promise<{ framework: Framework; language: Language; confidence: string }> {
  try {
    // Send only basenames — no full paths, no file contents
    const basenames = files.map(f => path.basename(f))

    // Also include root-level config filenames explicitly
    const rootFiles = fs.readdirSync(rootPath).filter(f => {
      try { return fs.statSync(path.join(rootPath, f)).isFile() } catch { return false }
    })

    const allNames = [...new Set([...basenames, ...rootFiles])]

    const res = await fetch(`${FLOW_SERVER}/api/detect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: allNames, packages }),
      signal: AbortSignal.timeout(5000) // 5s timeout — don't block the UI
    })

    if (!res.ok) { throw new Error(`HTTP ${res.status}`) }
    const data = await res.json() as { framework?: string; language?: string; confidence?: string }
    return {
      framework:  (data.framework  ?? 'unknown') as Framework,
      language:   (data.language   ?? 'unknown') as Language,
      confidence: (data.confidence ?? 'low'),
    }
  } catch {
    return { framework: 'unknown' as Framework, language: 'unknown' as Language, confidence: 'low' }
  }
}

// ── Manual override key ──────────────────────────────────────
function manualOverrideKey(rootPath: string): string {
  const pid = Buffer.from(rootPath).toString('base64').slice(0, 16)
  return `itk_framework_override_${pid}`
}

export function getManualOverride(
  ctx: vscode.ExtensionContext,
  rootPath: string
): { framework: Framework; language: Language } | null {
  const val = ctx.workspaceState.get<{ framework: string; language: string }>(manualOverrideKey(rootPath))
  if (!val) { return null }
  return {
    framework: (val.framework ?? 'unknown') as Framework,
    language:  (val.language  ?? 'unknown') as Language,
  }
}

export async function saveManualOverride(
  ctx: vscode.ExtensionContext,
  rootPath: string,
  framework: string,
  language: string
): Promise<void> {
  await ctx.workspaceState.update(manualOverrideKey(rootPath), { framework, language })
}

export async function clearManualOverride(
  ctx: vscode.ExtensionContext,
  rootPath: string
): Promise<void> {
  await ctx.workspaceState.update(manualOverrideKey(rootPath), undefined)
}

// ── MAIN SCANNER ─────────────────────────────────────────────
export async function scanProject(
  ctx?: vscode.ExtensionContext
): Promise<ProjectInfo | null> {
  const folders = vscode.workspace.workspaceFolders
  if (!folders || folders.length === 0) {
    vscode.window.showWarningMessage('ITK: Open a project folder first.')
    return null
  }

  let rootPath = folders[0].uri.fsPath

  // Collect all source files
  const sourceFiles   = walkDir(rootPath)
  const sourceContents: Record<string, string> = {}
  for (const f of sourceFiles) { sourceContents[f] = readFile(f) }

  // Also include package/config files
  for (const extraFile of ['requirements.txt','Pipfile','pyproject.toml','package.json','composer.json','Gemfile']) {
    const fp = path.join(rootPath, extraFile)
    if (fs.existsSync(fp)) { sourceContents[fp] = readFile(fp) }
  }

  const packages = readInstalledPackages(rootPath)

  // ── Step 0: Find the actual project root ─────────────────────────────────────
  // The workspace root may be a parent folder (e.g. docker-compose root, monorepo).
  // Walk subdirectories up to 2 levels deep to find the real project folder.
  const PROJECT_SIGNALS = [
    'artisan', 'manage.py', 'next.config.js', 'next.config.ts', 'next.config.mjs',
    'nuxt.config.js', 'nuxt.config.ts', 'nuxt.config.mjs',
    'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle',
    'composer.json', 'package.json', 'requirements.txt', 'Gemfile', 'Pipfile'
  ]

  const hasSignalAt = (dir: string) => PROJECT_SIGNALS.some(s => fs.existsSync(path.join(dir, s)))

  // Priority signals — if found, this is definitely the project root
  const STRONG_SIGNALS = ['artisan', 'manage.py', 'go.mod', 'Cargo.toml', 'pom.xml']
  const hasStrongSignal = (dir: string) => STRONG_SIGNALS.some(s => fs.existsSync(path.join(dir, s)))

  if (!hasSignalAt(rootPath)) {
    // Root has no project files — search subdirectories
    // Prefer directories with strong signals (artisan > package.json)
    const IGNORE = new Set(['.git', 'node_modules', 'vendor', '.next', 'dist', 'build', '__pycache__'])
    let found: string | null = null

    const searchDirs = (dir: string, depth: number) => {
      if (depth > 2 || found) { return }
      try {
        for (const entry of fs.readdirSync(dir)) {
          if (IGNORE.has(entry)) { continue }
          const sub = path.join(dir, entry)
          try {
            if (!fs.statSync(sub).isDirectory()) { continue }
            if (hasStrongSignal(sub)) { found = sub; return }
            if (!found && hasSignalAt(sub)) { found = sub }
            searchDirs(sub, depth + 1)
          } catch {}
        }
      } catch {}
    }

    searchDirs(rootPath, 0)
    if (found) { rootPath = found }
  }

  // ── Step 1: Check for manual override first ──────────────
  if (ctx) {
    const override = getManualOverride(ctx, rootPath)
    if (override) {
      return {
        language:           override.language as Language,
        framework:          override.framework as Framework,
        installedPackages:  packages,
        envKeyNames:        readEnvKeyNames(rootPath),
        rootPath,
        sourceFiles,
        sourceContents,
        detectedPort:       detectPort(rootPath),
        hardcodedKeyIssues: scanHardcodedKeys(sourceContents),
        detectionSource:    'manual' as DetectionSource
      }
    }
  }

  // ── Step 2: Try local detection ───────────────────────────
  const local = detectLocalFramework(rootPath, packages)

  if (local.framework !== 'unknown') {
    return {
      language:           local.language,
      framework:          local.framework,
      installedPackages:  packages,
      envKeyNames:        readEnvKeyNames(rootPath),
      rootPath,
      sourceFiles,
      sourceContents,
      detectedPort:       detectPort(rootPath),
      hardcodedKeyIssues: scanHardcodedKeys(sourceContents),
      detectionSource:    'local' as DetectionSource
    }
  }

  // ── Step 3: Fallback to server detection ──────────────────
  const server = await detectFromServer(rootPath, sourceFiles, packages)

  return {
    language:           (server.language !== 'unknown' ? server.language : local.language) as Language,
    framework:          server.framework,
    installedPackages:  packages,
    envKeyNames:        readEnvKeyNames(rootPath),
    rootPath,
    sourceFiles,
    sourceContents,
    detectedPort:       detectPort(rootPath),
    hardcodedKeyIssues: scanHardcodedKeys(sourceContents),
    detectionSource:    (server.framework !== 'unknown' ? 'server' : 'unknown') as DetectionSource
  }
}