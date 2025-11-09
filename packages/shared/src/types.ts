export enum TextDetailLevel {
  NONE = 0,
  VISIBLE = 1,
  FULL = 2,
}

export enum CSSDetailLevel {
  NONE = 0,
  BASIC = 1,
  BOX_MODEL = 2,
  FULL = 3,
}

export const DEFAULT_TEXT_DETAIL: TextDetailLevel = TextDetailLevel.FULL;

export const DEFAULT_CSS_LEVEL: CSSDetailLevel = CSSDetailLevel.BASIC;

export interface TextSnapshots {
  visible: string;
  full: string;
}

export interface ElementPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type CSSProperties = Record<string, string>;

export interface ComponentInfo {
  name?: string;
  sourceFile?: string;
  framework?: 'react' | 'vue' | 'angular' | 'svelte';
}

export interface TargetedElement {
  selector: string;
  tagName: string;
  id?: string;
  classes: string[];
  innerText?: string;
  textContent?: string;
  textDetail?: TextDetailLevel;
  textVariants?: TextSnapshots;
  attributes: Record<string, string>;
  position: ElementPosition;
  cssLevel?: CSSDetailLevel;
  cssProperties?: CSSProperties;
  cssComputed?: Record<string, string>;
  componentInfo?: ComponentInfo;
  timestamp: number;
  url: string;
  tabId?: number;
}

// Raw data from browser (minimal, fail-safe)
export interface RawPointedDOMElement {
  // Core data (mandatory)
  outerHTML: string; // Element's HTML serialization
  url: string; // Page URL
  timestamp: number; // Unix timestamp

  // Position data (optional but highly recommended)
  boundingClientRect?: DOMRect; // Position/size

  // Optional enhanced data
  computedStyles?: Record<string, string>; // Full CSS if configured
  reactFiber?: any; // React internals if available
}

// Pointer message types between extension and MCP server
export enum PointerMessageType {
  LEGACY_ELEMENT_SELECTED = 'element-selected',
  DOM_ELEMENT_POINTED = 'dom-element-pointed',
  SCREENSHOT_REQUEST = 'screenshot-request',
  SCREENSHOT_RESPONSE = 'screenshot-response',
  SCREENSHOT_ERROR = 'screenshot-error',
  PING = 'ping',
  PONG = 'pong',
}

export interface PointerMessage {
  type: PointerMessageType;
  data?: any;
  timestamp: number;
}

// Connection status for ElementSenderService
export enum ConnectionStatus {
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  SENDING = 'sending',
  SENT = 'sent',
  ERROR = 'error',
}

// Screenshot feature types
export enum ScreenshotFormat {
  PNG = 'png',
  JPEG = 'jpeg',
  WEBP = 'webp',
}

export enum ScreenshotErrorCode {
  NO_ELEMENT = 'NO_ELEMENT',
  NOT_VISIBLE = 'NOT_VISIBLE',
  CAPTURE_FAILED = 'CAPTURE_FAILED',
  TIMEOUT = 'TIMEOUT',
  PERMISSIONS_DENIED = 'PERMISSIONS_DENIED',
  EXTENSION_ERROR = 'EXTENSION_ERROR',
}

export interface ScreenshotData {
  base64: string; // Data URL or base64 string
  format: ScreenshotFormat;
  width: number; // Logical pixels
  height: number; // Logical pixels
  byteSize: number; // Approximate size in bytes
  capturedAt: number; // Unix timestamp
}

export interface ScreenshotOptions {
  format?: ScreenshotFormat;
  quality?: number; // 1-100, only for JPEG/WEBP
  maxWidth?: number; // Max width for scaling
  maxHeight?: number; // Max height for scaling
  timeout?: number; // Request timeout in ms
}

export interface ScreenshotRequestMessage {
  requestId: string;
  options: ScreenshotOptions;
  timestamp: number;
}

export interface ScreenshotResponseMessage {
  requestId: string;
  screenshot: ScreenshotData;
  elementSelector?: string; // For reference
  timestamp: number;
}

export interface ScreenshotErrorMessage {
  requestId: string;
  errorCode: ScreenshotErrorCode;
  errorMessage: string;
  timestamp: number;
}
