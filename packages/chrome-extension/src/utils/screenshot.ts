import { ScreenshotData, ScreenshotFormat, ScreenshotErrorCode } from '@mcp-pointer/shared/types';
import logger from './logger';

export class ScreenshotError extends Error {
  constructor(
    public code: ScreenshotErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ScreenshotError';
  }
}

/**
 * Check if an element is visible in the viewport
 */
export function isElementVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();

  // Check if element has dimensions
  if (rect.width === 0 || rect.height === 0) {
    return false;
  }

  // Check if element intersects with viewport
  const viewport = {
    top: 0,
    left: 0,
    bottom: window.innerHeight,
    right: window.innerWidth,
  };

  const intersects = !(
    rect.bottom < viewport.top ||
    rect.top > viewport.bottom ||
    rect.right < viewport.left ||
    rect.left > viewport.right
  );

  return intersects;
}

/**
 * Interface for element bounds data sent to background script
 */
export interface ElementBounds {
  rect: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  devicePixelRatio: number;
}

/**
 * Validate element and get bounds for screenshot (content script side)
 * Returns element bounds to be sent to background script for capture
 */
export function getElementBoundsForScreenshot(element: HTMLElement): ElementBounds {
  logger.debug('📸 Validating element for screenshot');

  // Validate element visibility
  if (!isElementVisible(element)) {
    throw new ScreenshotError(
      ScreenshotErrorCode.NOT_VISIBLE,
      'Element is not visible in the viewport. Scroll it into view and try again.'
    );
  }

  // Get element bounds
  const rect = element.getBoundingClientRect();
  const devicePixelRatio = window.devicePixelRatio || 1;

  return {
    rect: {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    },
    devicePixelRatio,
  };
}

/**
 * Crop screenshot to element bounds using canvas (can be called from background script)
 */
export async function cropToElement(
  dataUrl: string,
  rect: { left: number; top: number; width: number; height: number },
  devicePixelRatio: number,
  targetFormat: ScreenshotFormat,
  quality: number
): Promise<ScreenshotData> {
  return new Promise((resolve, reject) => {
    const img = new Image();

    img.onload = () => {
      try {
        // Calculate crop dimensions accounting for device pixel ratio
        const cropX = Math.max(0, rect.left * devicePixelRatio);
        const cropY = Math.max(0, rect.top * devicePixelRatio);
        const cropWidth = rect.width * devicePixelRatio;
        const cropHeight = rect.height * devicePixelRatio;

        // Ensure crop dimensions are within image bounds
        const actualWidth = Math.min(cropWidth, img.width - cropX);
        const actualHeight = Math.min(cropHeight, img.height - cropY);

        // Create canvas for cropping
        const canvas = document.createElement('canvas');
        canvas.width = actualWidth;
        canvas.height = actualHeight;

        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Failed to get canvas 2D context');
        }

        // Draw cropped region
        ctx.drawImage(
          img,
          cropX,
          cropY,
          actualWidth,
          actualHeight,
          0,
          0,
          actualWidth,
          actualHeight
        );

        // Convert to target format
        const mimeType = getMimeType(targetFormat);
        const qualityParam = targetFormat !== ScreenshotFormat.PNG ? quality / 100 : undefined;
        const croppedDataUrl = canvas.toDataURL(mimeType, qualityParam);

        // Calculate byte size (approximation)
        const base64Length = croppedDataUrl.split(',')[1]?.length || 0;
        const byteSize = Math.floor((base64Length * 3) / 4);

        resolve({
          base64: croppedDataUrl,
          format: targetFormat,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          byteSize,
          capturedAt: Date.now(),
        });
      } catch (error) {
        reject(new ScreenshotError(
          ScreenshotErrorCode.CAPTURE_FAILED,
          `Failed to crop image: ${error instanceof Error ? error.message : 'Unknown error'}`
        ));
      }
    };

    img.onerror = () => {
      reject(new ScreenshotError(
        ScreenshotErrorCode.CAPTURE_FAILED,
        'Failed to load captured image'
      ));
    };

    img.src = dataUrl;
  });
}

/**
 * Get MIME type for screenshot format
 */
export function getMimeType(format: ScreenshotFormat): string {
  switch (format) {
    case ScreenshotFormat.PNG:
      return 'image/png';
    case ScreenshotFormat.JPEG:
      return 'image/jpeg';
    case ScreenshotFormat.WEBP:
      return 'image/webp';
    default:
      return 'image/png';
  }
}

/**
 * Calculate byte size from base64 string
 */
export function calculateByteSize(base64: string): number {
  const base64Data = base64.includes(',') ? base64.split(',')[1] : base64;
  return Math.floor((base64Data.length * 3) / 4);
}
