import { request } from "./client";
import type { AuthResponse, User } from "../types/api";

export function login(email: string, password: string): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/login", {
    method: "POST",
    body: { email, password },
    auth: false,
  });
}

export function register(
  email: string, password: string, name: string,
): Promise<AuthResponse> {
  return request<AuthResponse>("/auth/register", {
    method: "POST",
    body: { email, password, name },
    auth: false,
  });
}

export function me(): Promise<User> {
  return request<User>("/auth/me");
}
