export const ROLES = ["admin", "marketing_manager", "marketer", "pharma_team", "lead_agent", "viewer"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrator",
  marketing_manager: "Marketing manager",
  marketer: "Marketer",
  pharma_team: "Pharmaceutical team",
  lead_agent: "Inquiry agent",
  viewer: "Viewer",
};

export const PERMISSIONS = [
  "trends.view",
  "trends.refresh",
  "analytics.view",
  "analytics.sync",
  "content.generate",
  "posts.view",
  "posts.edit",
  "posts.approve",
  "posts.schedule",
  "campaigns.manage",
  "reports.view",
  "logs.view",
  "leads.view",
  "leads.view_all",
  "leads.manage",
  "leads.reply",
  "leads.review",
  "leads.export",
  "leads.delete",
  "templates.view",
  "templates.manage",
  "templates.approve",
  "users.manage",
  "settings.manage",
  "audit.view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const marketingRead: Permission[] = ["trends.view", "analytics.view", "posts.view", "reports.view"];

const GRANTS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  marketing_manager: [
    ...marketingRead,
    "trends.refresh",
    "analytics.sync",
    "content.generate",
    "posts.edit",
    "posts.approve",
    "posts.schedule",
    "campaigns.manage",
    "logs.view",
  ],
  marketer: [...marketingRead, "trends.refresh", "content.generate", "posts.edit"],
  // The pharmaceutical team reviews prescription, medical, regulatory and availability questions
  pharma_team: [
    "leads.view",
    "leads.view_all",
    "leads.manage",
    "leads.reply",
    "leads.review",
    "leads.export",
    "templates.view",
    "templates.manage",
    "templates.approve",
  ],
  lead_agent: ["leads.view", "leads.manage", "leads.reply", "templates.view"],
  viewer: marketingRead,
};

export function can(role: Role, perm: Permission): boolean {
  return GRANTS[role]?.includes(perm) ?? false;
}

export function permissionsFor(role: Role): Permission[] {
  return [...(GRANTS[role] ?? [])];
}
