import { ScreenshotData, ScreenshotFormat } from '@mcp-pointer/shared/types';
import logger from '../logger';

let sharp: any = null;

// Try to load sharp (optional dependency)
try {
  sharp = require('sharp');
} catch (error) {
  logger.warn('⚠️ Sharp not available - image scaling will be disabled');
  logger.warn('To enable scaling, install sharp: pnpm add sharp');
}

/**
 * Scale a screenshot to fit within max dimensions
 */
export async function scaleScreenshot(
  data: ScreenshotData,
  options: {
    maxWidth?: number;
    maxHeight?: number;
  }
): Promise<ScreenshotData> {
  // If no scaling options or sharp not available, return original
  if (!options.maxWidth && !options.maxHeight) {
    return data;
  }

  if (!sharp) {
    logger.warn('⚠️ Scaling requested but sharp is not available - returning original image');
    return data;
  }

  try {
    const startTime = Date.now();

    // Extract base64 data (remove data URL prefix if present)
    const base64Data = data.base64.includes(',')
      ? data.base64.split(',')[1]
      : data.base64;

    // Convert to buffer
    const buffer = Buffer.from(base64Data, 'base64');

    // Create sharp instance
    let pipeline = sharp(buffer);

    // Get metadata to determine current dimensions
    const metadata = await pipeline.metadata();
    const currentWidth = metadata.width || data.width;
    const currentHeight = metadata.height || data.height;

    logger.debug('📐 Original image dimensions:', { width: currentWidth, height: currentHeight });

    // Calculate new dimensions maintaining aspect ratio
    let newWidth = currentWidth;
    let newHeight = currentHeight;

    if (options.maxWidth && currentWidth > options.maxWidth) {
      const ratio = options.maxWidth / currentWidth;
      newWidth = options.maxWidth;
      newHeight = Math.round(currentHeight * ratio);
    }

    if (options.maxHeight && newHeight > options.maxHeight) {
      const ratio = options.maxHeight / newHeight;
      newHeight = options.maxHeight;
      newWidth = Math.round(newWidth * ratio);
    }

    // Only scale if dimensions actually changed
    if (newWidth === currentWidth && newHeight === currentHeight) {
      logger.debug('📏 No scaling needed - image already within max dimensions');
      return data;
    }

    logger.debug('📏 Scaling to:', { width: newWidth, height: newHeight });

    // Resize image
    pipeline = pipeline.resize({
      width: newWidth,
      height: newHeight,
      fit: 'inside',
      withoutEnlargement: true,
    });

    // Convert to target format
    let scaledBuffer: Buffer;

    switch (data.format) {
      case ScreenshotFormat.PNG:
        scaledBuffer = await pipeline.png().toBuffer();
        break;
      case ScreenshotFormat.JPEG:
        scaledBuffer = await pipeline.jpeg({ quality: 90 }).toBuffer();
        break;
      case ScreenshotFormat.WEBP:
        scaledBuffer = await pipeline.webp({ quality: 90 }).toBuffer();
        break;
      default:
        scaledBuffer = await pipeline.png().toBuffer();
    }

    // Convert back to base64
    const scaledBase64 = scaledBuffer.toString('base64');
    const mimeType = getMimeType(data.format);
    const dataUrl = `data:${mimeType};base64,${scaledBase64}`;

    const duration = Date.now() - startTime;

    logger.info('✅ Image scaled successfully', {
      originalSize: data.byteSize,
      newSize: scaledBuffer.length,
      reduction: `${Math.round((1 - scaledBuffer.length / data.byteSize) * 100)}%`,
      duration: `${duration}ms`,
    });

    return {
      base64: dataUrl,
      format: data.format,
      width: newWidth,
      height: newHeight,
      byteSize: scaledBuffer.length,
      capturedAt: data.capturedAt,
    };
  } catch (error) {
    logger.error('❌ Failed to scale screenshot:', error);
    logger.warn('Returning original image');
    return data;
  }
}

/**
 * Get MIME type for screenshot format
 */
function getMimeType(format: ScreenshotFormat): string {
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
