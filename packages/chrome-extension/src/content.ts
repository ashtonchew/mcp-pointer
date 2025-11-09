// Content script - has access to both React Fiber and Chrome APIs in ISOLATED world
import ConfigStorageService from './services/config-storage-service';
import ElementPointerService from './services/element-pointer-service';
import logger from './utils/logger';
import { getElementBoundsForScreenshot, ScreenshotError, cropToElement } from './utils/screenshot';
import { ScreenshotErrorCode, ScreenshotFormat } from '@mcp-pointer/shared/types';

logger.debug('🌍 MCP Pointer content script loaded');

let pointer: ElementPointerService | null = null;

// Initialize pointer based on config
async function initializePointer() {
  try {
    const config = await ConfigStorageService.load();

    if (!pointer) {
      pointer = new ElementPointerService();

      if (IS_DEV) {
        // Export for potential debugging
        (window as any).pointerTargeter = pointer;
      }
    }

    if (config.enabled) {
      pointer.enable();
    } else {
      pointer.disable();
    }
  } catch (error) {
    logger.error('❌ Failed to initialize pointer:', error);
  }
}

// Listen for config changes and update pointer accordingly
ConfigStorageService.onChange((newConfig) => {
  if (pointer) {
    if (newConfig.enabled) {
      pointer.enable();
    } else {
      pointer.disable();
    }
  }
});

// Listen for screenshot requests from background script
chrome.runtime.onMessage.addListener(
  (request: any, _sender: any, sendResponse: (response: any) => void) => {
    if (request.type === 'CAPTURE_SCREENSHOT') {
      handleScreenshotRequest(request, sendResponse);
      return true; // Keep message channel open for async response
    }

    if (request.type === 'CROP_SCREENSHOT') {
      handleCropRequest(request, sendResponse);
      return true; // Keep message channel open for async response
    }
  }
);

async function handleScreenshotRequest(
  request: { requestId: string; options: any },
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    logger.debug('📸 Screenshot bounds request received:', request.requestId);

    // Get the last pointed element
    if (!pointer) {
      throw new ScreenshotError(
        ScreenshotErrorCode.EXTENSION_ERROR,
        'Pointer service not initialized'
      );
    }

    const element = pointer.getLastPointedElement();
    const metadata = pointer.getLastPointedElementMetadata();

    if (!element) {
      throw new ScreenshotError(
        ScreenshotErrorCode.NO_ELEMENT,
        'No element has been pointed to yet. Option+Click an element first.'
      );
    }

    // Get element bounds (validation happens here)
    const bounds = getElementBoundsForScreenshot(element);

    // Send bounds back to background script
    sendResponse({
      success: true,
      requestId: request.requestId,
      bounds,
      elementSelector: metadata?.selector,
    });

    logger.debug('✅ Element bounds sent to background');
  } catch (error) {
    logger.error('❌ Element bounds validation failed:', error);

    if (error instanceof ScreenshotError) {
      sendResponse({
        success: false,
        requestId: request.requestId,
        errorCode: error.code,
        errorMessage: error.message,
      });
    } else {
      sendResponse({
        success: false,
        requestId: request.requestId,
        errorCode: ScreenshotErrorCode.EXTENSION_ERROR,
        errorMessage: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }
}

async function handleCropRequest(
  request: {
    dataUrl: string;
    bounds: { left: number; top: number; width: number; height: number };
    devicePixelRatio: number;
    format: ScreenshotFormat;
    quality: number;
  },
  sendResponse: (response: any) => void
): Promise<void> {
  try {
    logger.debug('✂️ Cropping screenshot in content script');

    const screenshot = await cropToElement(
      request.dataUrl,
      request.bounds,
      request.devicePixelRatio,
      request.format,
      request.quality
    );

    sendResponse({
      success: true,
      screenshot,
    });

    logger.debug('✅ Screenshot cropped successfully');
  } catch (error) {
    logger.error('❌ Screenshot cropping failed:', error);

    sendResponse({
      success: false,
      errorMessage: error instanceof Error ? error.message : 'Unknown cropping error',
    });
  }
}

// Initialize on script load
initializePointer();
