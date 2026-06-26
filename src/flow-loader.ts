import * as vscode from 'vscode'
import { ProjectInfo } from './types'

const FLOW_SERVER = 'https://flow-server-nine.vercel.app'
const CACHE_TTL   = 7 * 24 * 60 * 60 * 1000

interface CachedFlow {
  data: any
  fetchedAt: number
}

function cacheKey(framework: string, service: string, feature: string): string {
  return `itk_flow_${framework}_${service}_${feature}`
}

export async function loadFlow(
  context: vscode.ExtensionContext,
  project: ProjectInfo,
  service: string,
  feature: string
): Promise<any | null> {
  const key = cacheKey(project.framework, service, feature)

  // Check cache first
  const cached: CachedFlow | undefined = context.globalState.get(key)
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.data
  }

  try {
    const url      = `${FLOW_SERVER}/flows/${service}-${feature}.json`
    const response = await fetch(url)
    if (!response.ok) {
      vscode.window.showErrorMessage(`ITK: Could not load flow — HTTP ${response.status}`)
      return null
    }
    const data = await response.json() as any

    // Cache it
    await context.globalState.update(key, { data, fetchedAt: Date.now() })

    return data

  } catch(e: any) {
    // Fallback to stale cache if available
    if (cached) {
      vscode.window.showWarningMessage('ITK: Could not reach server — using cached flow')
      return cached.data
    }
    vscode.window.showErrorMessage(`ITK: Error loading flow — ${e.message}`)
    return null
  }
}

export async function refreshFlow(
  context: vscode.ExtensionContext,
  project: ProjectInfo,
  service: string,
  feature: string
): Promise<any | null> {
  const key = cacheKey(project.framework, service, feature)
  await context.globalState.update(key, undefined)
  return loadFlow(context, project, service, feature)
}

export function getForFramework(field: any, framework: string): any {
  if (!field) { return field }
  if (typeof field === 'string') { return field }
  if (typeof field === 'object') {
    return field[framework] || field['all'] || field
  }
  return field
}