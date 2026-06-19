import { ConnectionId, pluginCall } from "./api.ts";
import { genId } from "./store.ts";

// --- HTTP Client (curlui) ---------------------------------------------------

export type BodyKind = "none" | "json" | "text" | "form";

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  body_kind: BodyKind;
}

export interface HttpResponse {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body: string;
  body_encoding: string;
  elapsed_ms: number;
  curl_command: string;
}

export interface HttpFolder {
  id: string;
  name: string;
  folders: HttpFolder[];
  requests: HttpRequestItem[];
}

export interface HttpRequestItem {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  body_kind: BodyKind;
}

export interface HttpCollection {
  id: string;
  name: string;
  folders: HttpFolder[];
  requests: HttpRequestItem[];
}

export interface CollectionsFile {
  version: 1;
  collections: HttpCollection[];
}

export const COLLECTIONS_FILE = "collections";
export const COLLECTIONS_EXT = "json";

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

export function defaultCollectionsFile(): CollectionsFile {
  return {
    version: 1,
    collections: [
      {
        id: genId(),
        name: "Default",
        folders: [],
        requests: [],
      },
    ],
  };
}

export function newRequest(name = "New request"): HttpRequestItem {
  return {
    id: genId(),
    name,
    method: "GET",
    url: "",
    headers: {},
    body: "",
    body_kind: "none",
  };
}

export const curlui_api = {
  httpSend: (connectionId: ConnectionId, request: HttpRequest) =>
    pluginCall<HttpResponse>(connectionId, "curlui.send", { request }),

  httpParseCurl: (connectionId: ConnectionId, curl: string) =>
    pluginCall<HttpRequest>(connectionId, "curlui.parse_curl", { curl }),
};
