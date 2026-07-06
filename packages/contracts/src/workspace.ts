export interface WorkspaceProfile {
  id: string;
  label: string;
  cwd?: string;
  employee?: string;
  hasInstructions: boolean;
}

export interface WorkspaceProfilesResponse {
  profiles: WorkspaceProfile[];
}
