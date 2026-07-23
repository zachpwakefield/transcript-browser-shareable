import type { BrowserViewState } from "../types";
import { encodeViewState, parseViewState, requestedBuildHash } from "./urlState";
import {
  MAX_USER_ANNOTATIONS,
  createUserAnnotation,
  parseEntityKey,
  type EntityKey,
  type UserAnnotation,
} from "./workspaceStore";

export const SESSION_FORMAT = "local-transcript-browser-session";
export const MAX_SESSION_BYTES = 512 * 1024;

export interface PortableSession {
  view: BrowserViewState;
  annotations: Partial<Record<EntityKey, UserAnnotation>>;
}

export function encodeSession(
  state: BrowserViewState,
  annotations: Partial<Record<EntityKey, UserAnnotation>> = {},
): string {
  return JSON.stringify({
    format: SESSION_FORMAT,
    version: 2,
    buildHash: state.buildHash,
    urlState: encodeViewState(state),
    annotations,
  }, null, 2);
}

function parseAnnotations(value: unknown): Partial<Record<EntityKey, UserAnnotation>> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Session annotations must be one object.");
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_USER_ANNOTATIONS) throw new Error(`Session annotations exceed the ${MAX_USER_ANNOTATIONS}-entity limit.`);
  const annotations: Partial<Record<EntityKey, UserAnnotation>> = {};
  for (const [rawKey, rawAnnotation] of entries) {
    const key = parseEntityKey(rawKey);
    if (!key || !rawAnnotation || typeof rawAnnotation !== "object" || Array.isArray(rawAnnotation)) {
      throw new Error("Session contains an invalid local annotation.");
    }
    const record = rawAnnotation as Record<string, unknown>;
    if (typeof record.note !== "string" || !Array.isArray(record.tags) || !record.tags.every((tag) => typeof tag === "string") || typeof record.updatedAt !== "string") {
      throw new Error("Session contains an invalid local annotation.");
    }
    annotations[key] = createUserAnnotation(record.note, record.tags as string[], record.updatedAt);
  }
  return annotations;
}

export function parsePortableSession(
  text: string,
  fallback: BrowserViewState,
  currentBuildHash: string,
): PortableSession {

  if (new TextEncoder().encode(text).byteLength > MAX_SESSION_BYTES) {
    throw new Error("Session file exceeds the 512 KiB safety limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Session file is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Session file must contain one JSON object.");
  }
  const record = value as Record<string, unknown>;
  if (record.format !== SESSION_FORMAT || (record.version !== 1 && record.version !== 2) || typeof record.urlState !== "string") {
    throw new Error("Session file format or version is not supported.");
  }
  const declaredBuild = typeof record.buildHash === "string" ? record.buildHash : requestedBuildHash(record.urlState);
  if (!declaredBuild || declaredBuild !== currentBuildHash) {
    throw new Error(`Session requires build ${declaredBuild ?? "<missing>"}; current build is ${currentBuildHash}.`);
  }
  const encodedBuild = requestedBuildHash(record.urlState);
  if (encodedBuild !== currentBuildHash) {
    throw new Error("Session build metadata and encoded view disagree.");
  }
  return {
    view: {
      ...parseViewState(record.urlState, { ...fallback, buildHash: currentBuildHash }),
      buildHash: currentBuildHash,
    },
    annotations: record.version === 2 ? parseAnnotations(record.annotations) : {},
  };
}

export function parseSession(
  text: string,
  fallback: BrowserViewState,
  currentBuildHash: string,
): BrowserViewState {
  return parsePortableSession(text, fallback, currentBuildHash).view;
}
