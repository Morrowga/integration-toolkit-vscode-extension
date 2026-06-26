import * as vscode from 'vscode'
import * as crypto from 'crypto'
import * as path from 'path'
import { ProjectInfo } from './types'

// ─────────────────────────────────────────────────────────────
//  TYPES
// ─────────────────────────────────────────────────────────────
interface ComponentResult {
  id: string
  status: 'done' | 'missing' | 'wrong'
  note: string
}

interface AnalysisResult {
  language: string
  framework: string
  port: string
  components: ComponentResult[]
  summary: string
  allDone: boolean
}

interface AICache {
  result: AnalysisResult
  fileHash: string
  checkedAt: number
}

// ─────────────────────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────────────────────
let activeCallId: string | null = null
const debounceTimers: Record<string, ReturnType<typeof setTimeout>> = {}

// ─────────────────────────────────────────────────────────────
//  HASH
// ─────────────────────────────────────────────────────────────
function hashProject(project: ProjectInfo): string {
  const content = [
    project.installedPackages.join(','),
    project.envKeyNames.join(','),
    ...Object.values(project.sourceContents)
  ].join('||')
  return crypto.createHash('md5').update(content).digest('hex').slice(0, 16)
}

function cacheKey(project: ProjectInfo, service: string, feature: string): string {
  return `itk_analysis_${project.rootPath.slice(-20).replace(/\W/g,'')}_${project.framework}_${service}_${feature}`
}

// ─────────────────────────────────────────────────────────────
//  SMART FILE SCORING
//  Score files by how likely they are to contain integration code.
//  Higher score = shown first / included in content.
// ─────────────────────────────────────────────────────────────

// Keywords per service that indicate a file is integration-relevant
const SERVICE_KEYWORDS: Record<string, string[]> = {
  stripe:     ['stripe', 'checkout', 'subscription', 'webhook', 'payment', 'invoice', 'refund'],
  firebase:   ['firebase', 'firestore', 'auth', 'fcm', 'messaging', 'storage', 'onSnapshot'],
  aws:        ['s3', 'aws', 'bucket', 'presign', 'putobject', 'boto3', 'dynamodb', 'lambda', 'sns', 'sqs'],
  supabase:   ['supabase', 'createClient'],
  resend:     ['resend', 'sendEmail', 'ses'],
  twilio:     ['twilio', 'sms', 'whatsapp'],
  openai:     ['openai', 'gpt', 'completion', 'embedding'],
  anthropic:  ['anthropic', 'claude', 'messages.create', 'tool_use', 'tool_result'],
}

// File path segments that indicate service/integration code
const HIGH_VALUE_PATHS = [
  'service', 'services', 'controller', 'controllers', 'handler', 'handlers',
  'webhook', 'webhooks', 'route', 'routes', 'api', 'lib', 'utils', 'helper',
  'integration', 'payment', 'stripe', 'firebase', 'aws', 's3', 'auth',
  'middleware', 'action', 'actions', 'jobs', 'job',
]

// File path segments to deprioritize
const LOW_VALUE_PATHS = [
  'migration', 'migrations', 'seeder', 'seeders', 'test', 'tests', 'spec',
  'node_modules', '__pycache__', '.git', 'vendor', 'dist', 'build',
  'lang', 'locale', 'translation', 'public/css', 'public/js', 'storage/logs',
]

function scoreFile(filePath: string, content: string, service: string): number {
  const lower     = filePath.toLowerCase()
  const segments  = lower.split(path.sep)
  const basename  = path.basename(lower)
  let score = 0

  // Deprioritize noise files immediately
  if (LOW_VALUE_PATHS.some(p => lower.includes(p))) { return -100 }

  // Boost files in high-value directories
  if (HIGH_VALUE_PATHS.some(p => segments.some(s => s === p || s.startsWith(p)))) { score += 20 }

  // Boost files whose name contains the service name
  const svcKeywords = SERVICE_KEYWORDS[service.toLowerCase()] ?? []
  if (svcKeywords.some(kw => basename.includes(kw))) { score += 40 }

  // Boost if file content contains service keywords (most reliable signal)
  const contentLower = content.toLowerCase()
  const keywordHits  = svcKeywords.filter(kw => contentLower.includes(kw)).length
  score += keywordHits * 15

  // Boost config/env files — always useful for credential detection
  if (['config', 'settings', '.env.example', 'services.php', 'filesystems.php'].some(n => basename.includes(n))) {
    score += 25
  }

  // Boost composer.json, package.json, requirements.txt — package list is critical
  if (['composer.json', 'package.json', 'requirements.txt', 'gemfile', 'go.mod'].includes(basename)) {
    score += 30
  }

  // Small boost for shorter paths (closer to root = more likely to be a key file)
  score += Math.max(0, 10 - segments.length)

  return score
}

// ─────────────────────────────────────────────────────────────
//  BUILD PROMPT
// ─────────────────────────────────────────────────────────────
function buildPrompt(project: ProjectInfo, flow: any, service: string, feature: string): string {
  const lines: string[] = []

  // ── Project metadata ────────────────────────────────────────
  lines.push('=== PROJECT INFO ===')
  lines.push(`Installed packages: ${project.installedPackages.slice(0, 50).join(', ')}`)
  lines.push(`Env keys present (values hidden): ${project.envKeyNames.join(', ')}`)
  lines.push(`Detected framework: ${project.framework}`)
  lines.push(`Detected language: ${project.language}`)
  lines.push('')

  // ── Full file list (up to 60 filenames) ─────────────────────
  const allFilePaths = Object.keys(project.sourceContents)
  const relativeNames = allFilePaths
    .map(fp => fp.replace(project.rootPath + '/', '').replace(project.rootPath + path.sep, ''))
    .filter(f => !f.includes('node_modules') && !f.includes('vendor/'))

  lines.push('=== FILE STRUCTURE (up to 60 files) ===')
  lines.push(relativeNames.slice(0, 60).join('\n'))
  lines.push('')

  // ── Smart file selection: score and sort by relevance ────────
  const scored = allFilePaths
    .map(fp => ({
      fp,
      name:    fp.replace(project.rootPath + '/', '').replace(project.rootPath + path.sep, ''),
      content: project.sourceContents[fp] ?? '',
      score:   scoreFile(fp, project.sourceContents[fp] ?? '', service),
    }))
    .filter(f => f.score > -100)
    .sort((a, b) => b.score - a.score)

  const MAX_FILES      = 15
  const MAX_LINES_HIGH = 80
  const MAX_LINES_LOW  = 40

  lines.push('=== FILE CONTENTS (most relevant files first) ===')

  let filesShown = 0
  for (const { name, content, score } of scored) {
    if (filesShown >= MAX_FILES) { break }
    if (!content.trim())         { continue }

    const maxLines = score > 30 ? MAX_LINES_HIGH : MAX_LINES_LOW
    const trimmed  = content.split('\n').slice(0, maxLines).join('\n')

    lines.push(`--- ${name} (relevance: ${score > 50 ? 'high' : score > 20 ? 'medium' : 'low'}) ---`)
    lines.push(trimmed)
    lines.push('')
    filesShown++
  }

  // ── What to analyze ─────────────────────────────────────────
  lines.push(`=== INTEGRATION TO CHECK: ${service.toUpperCase()} — ${feature} ===`)
  lines.push('')
  lines.push(flow.code?.checkPrompt ?? `Analyze the ${service} integration code.`)
  lines.push('')

  // ── Components ──────────────────────────────────────────────
  lines.push('=== COMPONENTS TO CHECK ===')
  for (const comp of (flow.code?.components ?? [])) {
    lines.push(`- id:"${comp.id}"`)
    lines.push(`  label:"${comp.label}"`)
    lines.push(`  description:"${comp.description}"`)
  }

  // ── Response format ─────────────────────────────────────────
  lines.push('')
  lines.push('=== REQUIRED RESPONSE FORMAT ===')
  lines.push('Return ONLY this JSON — no markdown, no explanation:')
  lines.push('{')
  lines.push('  "language": "javascript|typescript|python|php|ruby|go|java|rust|unknown",')
  lines.push('  "framework": "nextjs|nuxt|react|express|laravel|symfony|django|fastapi|flask|rails|go|springboot|rust|unknown",')
  lines.push('  "port": "detected port number or empty string",')
  lines.push('  "components": [')
  lines.push('    {')
  lines.push('      "id": "component id from list above",')
  lines.push('      "status": "done|missing|wrong",')
  lines.push('      "note": "clear explanation of what you found or what is needed"')
  lines.push('    }')
  lines.push('  ],')
  lines.push('  "summary": "2-3 sentence overview of what is implemented and what needs attention"')
  lines.push('}')
  lines.push('')

  // ── Judgment rules ───────────────────────────────────────────
  lines.push('=== JUDGMENT RULES ===')
  lines.push('- done   = the integration exists and is functionally correct for this framework')
  lines.push('- missing = the integration is genuinely absent from the entire codebase')
  lines.push('- wrong  = the integration exists but has a real bug or security issue')
  lines.push('')
  lines.push('IMPORTANT — be generous with "done":')
  lines.push('- Different folder structures are fine: app/Services/, lib/, utils/, src/ all count')
  lines.push('- Different naming conventions are fine: S3Service, StorageHelper, AwsUploader all count')
  lines.push('- Framework-native alternatives count: Laravel Storage::disk("s3") = correct S3 upload')
  lines.push('- Third-party wrappers count: Cashier for Stripe, django-storages for S3, etc.')
  lines.push('- Partial implementations count as "done" for that component if the core is there')
  lines.push('')
  lines.push('IMPORTANT — notes must be honest about what you saw:')
  lines.push('- If you found the implementation, say what file/class/method you found it in')
  lines.push('- If you did NOT find it in the files shown, say "Not found in reviewed files — may exist elsewhere"')
  lines.push('- Do NOT hallucinate filenames that are not in the file structure above')
  lines.push('- If only some files were shown, you may have missed it — prefer "missing" over "wrong" when uncertain')
  lines.push('- Only flag "wrong" when you actually saw the problematic code in the files above')

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────
//  CALL SERVER
// ─────────────────────────────────────────────────────────────
async function callServer(prompt: string, callId: string): Promise<AnalysisResult | null> {
  const response = await fetch('https://flow-server-nine.vercel.app/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot: prompt })
  })

  if (activeCallId !== callId) { return null }
  if (!response.ok) { throw new Error(`Server error: ${response.status}`) }

  const data = await response.json() as any

  const components = data.components ?? []
  const allDone    = components.length > 0 && components.every((c: any) => c.status === 'done')

  return {
    language:   data.language  ?? 'unknown',
    framework:  data.framework ?? 'unknown',
    port:       data.port      ?? '',
    components,
    summary:    data.summary   ?? '',
    allDone
  }
}

// ─────────────────────────────────────────────────────────────
//  CHECK FRAMEWORK SUPPORT
//  Returns true if the framework has NO sample code in ANY component.
//  This means the service does not officially support this framework.
// ─────────────────────────────────────────────────────────────
function isFrameworkUnsupported(flow: any, framework: string): boolean {
  const components: any[] = flow.code?.components ?? []
  if (components.length === 0) { return false }

  // Framework is unsupported if every component either:
  // - has no sample for this framework at all
  // - has the __NOT_SUPPORTED__ sentinel value
  return components.every((comp: any) => {
    const sample = comp.samples?.[framework]
    return !sample || sample === '__NOT_SUPPORTED__'
  })
}

function buildUnsupportedResult(project: ProjectInfo, flow: any): AnalysisResult {
  const components: any[] = flow.code?.components ?? []
  const fw = project.framework

  // Map framework id to a readable label for the message
  const FW_LABELS: Record<string, string> = {
    nextjs: 'Next.js', react: 'React', nuxt: 'Nuxt', express: 'Express',
    laravel: 'Laravel', django: 'Django', fastapi: 'FastAPI', flask: 'Flask',
    rails: 'Ruby on Rails', go: 'Go', springboot: 'Spring Boot', rust: 'Rust',
  }
  const fwLabel = FW_LABELS[fw] ?? fw

  return {
    language:   project.language,
    framework:  fw,
    port:       '',
    components: components.map((comp: any) => ({
      id:     comp.id,
      status: 'missing' as const,
      note:   `${fwLabel} is not supported for this integration — no official SDK or documented integration pattern is available. Check the service documentation for community packages or use the REST API directly.`,
    })),
    summary:  `${fwLabel} is not officially supported for this integration.`,
    allDone:  false,
  }
}

// ─────────────────────────────────────────────────────────────
//  DEBOUNCE + CANCEL
// ─────────────────────────────────────────────────────────────
function debounce(key: string, fn: () => void, delay = 3000): void {
  if (debounceTimers[key]) { clearTimeout(debounceTimers[key]) }
  debounceTimers[key] = setTimeout(fn, delay)
}

export function cancelPendingAI(): void {
  activeCallId = null
  for (const key of Object.keys(debounceTimers)) {
    clearTimeout(debounceTimers[key])
    delete debounceTimers[key]
  }
}

export function applyCheckingState(flow: any, _project: ProjectInfo): any {
  return flow
}

// ─────────────────────────────────────────────────────────────
//  MAIN EXPORT — analyzeCode
// ─────────────────────────────────────────────────────────────
export async function analyzeCode(
  context: vscode.ExtensionContext,
  project: ProjectInfo,
  flow: any,
  service: string,
  feature: string,
  onComplete?: (result: AnalysisResult, project: ProjectInfo) => void,
  force = false
): Promise<AnalysisResult | null> {
  if (!flow) { return null }

  const key      = cacheKey(project, service, feature)
  const fileHash = hashProject(project)
  const cached: AICache | undefined = context.workspaceState.get(key)

  // ── Framework support check — runs before cache and before AI call ──
  // If the framework has no sample code in any component, skip the AI
  // entirely and return an unsupported message immediately.
  if (isFrameworkUnsupported(flow, project.framework)) {
    const unsupportedResult = buildUnsupportedResult(project, flow)
    // Cache it so subsequent opens don't re-check
    await context.workspaceState.update(key, {
      result:    unsupportedResult,
      fileHash,
      checkedAt: Date.now(),
    } as AICache)
    onComplete?.(unsupportedResult, project)
    return unsupportedResult
  }

  // Cache hit — return immediately without calling AI
  if (!force && cached && cached.fileHash === fileHash) {
    onComplete?.(cached.result, project)
    return cached.result
  }

  const callId = `${key}_${Date.now()}`
  activeCallId = callId

  if (force) {
    await context.workspaceState.update(key, undefined)
  }

  if (onComplete) {
    const runAI = async () => {
      if (activeCallId !== callId) { return }
      try {
        const prompt = buildPrompt(project, flow, service, feature)
        const result = await callServer(prompt, callId)
        if (!result) { return }

        await context.workspaceState.update(key, { result, fileHash, checkedAt: Date.now() } as AICache)

        // Only update port from AI result — language/framework come from scanProject only
        if (result.port) { project.detectedPort = result.port }

        onComplete(result, project)
      } catch(e: any) {
        vscode.window.showWarningMessage(`ITK: Analysis failed — ${e.message}`)
        onComplete({
          language:   project.language,
          framework:  project.framework,
          port:       project.detectedPort,
          components: [],
          summary:    `Analysis failed: ${e.message}`,
          allDone:    false
        }, project)
      }
    }

    if (!cached || force) {
      runAI()
    } else {
      debounce(key, runAI, 3000)
    }
  }

  return null
}

// ─────────────────────────────────────────────────────────────
//  CLEAR CACHE
// ─────────────────────────────────────────────────────────────
export async function clearAICache(
  context: vscode.ExtensionContext,
  project: ProjectInfo,
  service: string,
  feature: string
): Promise<void> {
  await context.workspaceState.update(cacheKey(project, service, feature), undefined)
}