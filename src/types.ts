export type Language =
  | 'javascript'
  | 'typescript'
  | 'python'
  | 'php'
  | 'ruby'
  | 'go'
  | 'java'
  | 'rust'
  | 'unknown'

export type Framework =
  | 'nextjs' | 'react' | 'nuxt' | 'vue' | 'angular'
  | 'express' | 'laravel' | 'symfony'
  | 'django' | 'fastapi' | 'flask'
  | 'rails'
  | 'go'
  | 'springboot'
  | 'rust'
  | 'node' | 'python' | 'php' | 'unknown'

export type DetectionSource = 'manual' | 'local' | 'server' | 'unknown'

export interface ProjectInfo {
  language: Language
  framework: Framework
  installedPackages: string[]
  envKeyNames: string[]
  rootPath: string
  sourceFiles: string[]
  sourceContents: Record<string, string>
  detectedPort: string
  hardcodedKeyIssues: ScanIssue[]
  detectionSource: DetectionSource
}

export interface ScanIssue {
  file: string
  line: number
  message: string
  risk: string
}

export interface StripeFeature {
  id: string
  label: string
  description: string
  stepSummary: string
  icon: string
  iconColor: string
  iconBg: string
}

// Progress saved per project — completely separate from flow
export interface StepProgress {
  stepId: string
  confirmedByUser: boolean
  confirmedAt: string
  note: string
}

export type ProjectProgress = Record<string, StepProgress>