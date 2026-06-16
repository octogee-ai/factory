export type ConnectorCaptureMethod = 'oauth-web' | 'device' | 'pat' | 'fields';

export type ConnectorConsumption = 'platform-read' | 'agent-runtime';

export type ConnectorClientSource = 'platform' | 'per-user';

export type ConnectorFamily =
  | 'code-hosting'
  | 'deploy-hosting'
  | 'registry'
  | 'ai'
  | 'cloud'
  | 'productivity';

export type ConnectorId =
  | 'github'
  | 'vercel'
  | 'netlify'
  | 'cloudflare'
  | 'npm'
  | 'docker'
  | 'openai'
  | 'anthropic'
  | 'openrouter'
  | 'gemini'
  | 'aws'
  | 'gcp'
  | 'azure'
  | 'google'
  | 'microsoft'
  | 'yahoo';

export interface ConnectorCaptureField {
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  multiline?: boolean;
}

export interface ConnectorMeta {
  id: ConnectorId;
  displayName: string;
  tagline: string;
  family: ConnectorFamily;
  captureMethods: ConnectorCaptureMethod[];
  consumption: ConnectorConsumption;
  clientSource: ConnectorClientSource;
  scopes: string[];
  platformScopes?: string[];
  captureFields?: ConnectorCaptureField[];
  implemented: boolean;
}

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

export const GOOGLE_PLATFORM_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
];

export const MICROSOFT_SCOPES = [
  'Files.Read.All',
  'Mail.Read',
  'Mail.Send',
  'Calendars.Read',
  'Calendars.ReadWrite',
  'User.Read',
  'offline_access',
];

export const CONNECTOR_CATALOG: readonly ConnectorMeta[] = [
  {
    id: 'github',
    tagline: 'Your repos, in your project file browser',
    displayName: 'GitHub',
    family: 'code-hosting',
    captureMethods: ['oauth-web', 'device', 'pat'],
    consumption: 'platform-read',
    clientSource: 'platform',
    scopes: ['repo'],
    implemented: true,
  },
  {
    id: 'vercel',
    tagline: 'Deploys and previews',
    displayName: 'Vercel',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: true,
  },
  {
    id: 'netlify',
    tagline: 'Deploys and previews',
    displayName: 'Netlify',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: true,
  },
  {
    id: 'cloudflare',
    tagline: 'Workers, Pages and DNS',
    displayName: 'Cloudflare',
    family: 'deploy-hosting',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: true,
  },
  {
    id: 'npm',
    tagline: 'Publish and install packages',
    displayName: 'npm',
    family: 'registry',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: true,
  },
  {
    id: 'docker',
    tagline: 'Container images',
    displayName: 'Docker / GHCR',
    family: 'registry',
    captureMethods: ['fields'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    captureFields: [
      { key: 'username', label: 'Docker Hub username', placeholder: 'your-dockerhub-username' },
      { key: 'token', label: 'Access token', placeholder: 'dckr_pat_…', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'openai',
    tagline: 'ChatGPT subscription or API key',
    displayName: 'OpenAI',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: false,
  },
  {
    id: 'anthropic',
    tagline: 'Claude subscription or API key',
    displayName: 'Anthropic',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: false,
  },
  {
    id: 'openrouter',
    tagline: 'Any OpenAI-compatible model endpoint',
    displayName: 'OpenRouter',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: false,
  },
  {
    id: 'gemini',
    tagline: 'Gemini API key (Google AI Studio)',
    displayName: 'Google Gemini',
    family: 'ai',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: true,
  },
  {
    id: 'aws',
    tagline: 'Cloud credentials for your agent',
    displayName: 'AWS',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    captureFields: [
      { key: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret access key', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'gcp',
    tagline: 'Cloud credentials for your agent',
    displayName: 'Google Cloud',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    captureFields: [
      {
        key: 'serviceAccountJson',
        label: 'Service account key (JSON)',
        placeholder: 'Paste the downloaded key file contents',
        secret: true,
        multiline: true,
      },
    ],
    implemented: true,
  },
  {
    id: 'google',
    tagline: 'Drive, Gmail and Calendar for your agent',
    displayName: 'Google',
    family: 'productivity',
    captureMethods: ['oauth-web'],
    consumption: 'agent-runtime',
    clientSource: 'per-user',
    scopes: GOOGLE_SCOPES,
    platformScopes: GOOGLE_PLATFORM_SCOPES,
    implemented: true,
  },
  {
    id: 'microsoft',
    tagline: 'Outlook mail, calendar and OneDrive',
    displayName: 'Microsoft',
    family: 'productivity',
    captureMethods: ['oauth-web'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: MICROSOFT_SCOPES,
    implemented: true,
  },
  {
    id: 'azure',
    tagline: 'Cloud credentials for your agent',
    displayName: 'Azure',
    family: 'cloud',
    captureMethods: ['fields'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    captureFields: [
      { key: 'tenantId', label: 'Directory (tenant) ID' },
      { key: 'clientId', label: 'Application (client) ID' },
      { key: 'clientSecret', label: 'Client secret', secret: true },
    ],
    implemented: true,
  },
  {
    id: 'yahoo',
    tagline: 'Mail and calendar — via app passwords',
    displayName: 'Yahoo',
    family: 'productivity',
    captureMethods: ['pat'],
    consumption: 'agent-runtime',
    clientSource: 'platform',
    scopes: [],
    implemented: false,
  },
];

export type IntegrationStatus = 'connected' | 'disconnected' | 'error' | 'pending';

export interface IntegrationStatusDoc {
  provider: string;
  status: IntegrationStatus;
  accountLabel?: string;
  scopes?: string[];
  captureMethod?: ConnectorCaptureMethod;
  clientConfigured?: boolean;
  error?: string;
  connectedAt?: unknown;
  updatedAt?: unknown;
  verifiedAt?: unknown;
}
