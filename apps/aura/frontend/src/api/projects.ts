import { request } from "./client";

export type ProjectStatus = "active" | "at_risk" | "completed" | "archived";

export interface Project {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string;
  status: ProjectStatus;
  target_date: string | null;
  progress: number;
  created_at: string;
  updated_at: string;
}

export interface ProjectsOverview {
  total: number;
  active: number;
  at_risk: number;
  completed: number;
  archived: number;
}

export function listProjects(includeArchived = false): Promise<{ projects: Project[] }> {
  return request("/projects", { query: { include_archived: includeArchived } });
}

export function getOverview(): Promise<ProjectsOverview> {
  return request<ProjectsOverview>("/projects/overview");
}

export interface CreateProjectBody {
  name: string;
  description?: string | null;
  color?: string;
  status?: ProjectStatus;
  target_date?: string | null;
}

export function createProject(body: CreateProjectBody): Promise<Project> {
  return request<Project>("/projects", { method: "POST", body });
}

export interface UpdateProjectBody {
  name?: string;
  description?: string | null;
  color?: string;
  status?: ProjectStatus;
  target_date?: string | null;
  progress?: number;
}

export function updateProject(id: string, body: UpdateProjectBody): Promise<Project> {
  return request<Project>(`/projects/${encodeURIComponent(id)}`, { method: "PATCH", body });
}

export function deleteProject(id: string): Promise<{ ok: boolean }> {
  return request(`/projects/${encodeURIComponent(id)}`, { method: "DELETE" });
}
