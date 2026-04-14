import { request } from "./client";
import type {
  CreateTaskBody,
  Task,
  TaskListResponse,
  TaskStatus,
  UpdateTaskBody,
} from "../types/api";

export type TasksQuery = {
  status?: TaskStatus;
  type?: string;
  limit?: number;
  due_from?: string;
  due_to?: string;
};

export async function listTasks(query: TasksQuery = {}): Promise<Task[]> {
  const res = await request<TaskListResponse>("/tasks", { query: { ...query } });
  return res.tasks;
}

export function getTask(id: string): Promise<Task> {
  return request<Task>(`/tasks/${encodeURIComponent(id)}`);
}

export function createTask(body: CreateTaskBody): Promise<{ id: string; ok: boolean }> {
  return request("/tasks", { method: "POST", body });
}

export function updateTaskStatus(id: string, status: TaskStatus): Promise<{ ok: boolean }> {
  return request(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { status },
  });
}

export function updateTask(id: string, body: UpdateTaskBody): Promise<{ ok: boolean }> {
  return request(`/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body,
  });
}

export function deleteTask(id: string): Promise<{ ok: boolean }> {
  return request(`/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
