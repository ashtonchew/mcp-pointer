import { RawPointedDOMElement } from '@mcp-pointer/shared/types';
import logger from '../utils/logger';
import TriggerMouseService from './trigger-mouse-service';
import TriggerKeyService from './trigger-key-service';
import OverlayManagerService, { OverlayType } from './overlay-manager-service';
import { extractRawPointedDOMElement } from '../utils/element';

const POINTING_CLASS = 'mcp-pointer--is-pointing';

export default class ElementPointerService {
  private triggerKeyService: TriggerKeyService;

  private triggerMouseService: TriggerMouseService;

  private overlayManagerService: OverlayManagerService;

  private pointing: boolean = false;

  private hoveredElement: HTMLElement | null = null;

  private pointedElement: HTMLElement | null = null;

  private pointedElementMetadata: { selector: string; timestamp: number } | null = null;

  constructor() {
    this.triggerKeyService = new TriggerKeyService({
      onTriggerKeyStart: this.startPointing.bind(this),
      onTriggerKeyEnd: this.stopPointing.bind(this),
    });
    this.triggerMouseService = new TriggerMouseService({
      onHover: this.onHover.bind(this),
      onClick: this.onClick.bind(this),
    });
    this.overlayManagerService = new OverlayManagerService();
  }

  private onHover(target: HTMLElement): void {
    if (this.hoveredElement === target) return;

    if (this.pointedElement === target) {
      this.overlayManagerService.clearOverlay(OverlayType.HOVER);
      this.hoveredElement = null;
    } else {
      this.overlayManagerService.overlay(OverlayType.HOVER, target);
      this.hoveredElement = target;
    }
  }

  private onClick(target: HTMLElement): void {
    logger.debug('🎯 Option+click detected on:', target);

    if (this.pointedElement === target) {
      this.overlayManagerService.clearOverlay(OverlayType.SELECTION);
      this.overlayManagerService.overlay(OverlayType.HOVER, target);

      this.pointedElement = null;
      this.hoveredElement = target;
    } else {
      this.overlayManagerService.overlay(OverlayType.SELECTION, target);
      this.overlayManagerService.clearOverlay(OverlayType.HOVER);

      this.pointedElement = target;
      this.hoveredElement = null;

      this.sendToBackground(target);
    }
  }

  public enable(): void {
    this.triggerKeyService.registerListeners();

    logger.info('✅ Element pointer enabled');
  }

  public disable(): void {
    this.overlayManagerService.clearOverlay(OverlayType.HOVER);
    this.overlayManagerService.clearOverlay(OverlayType.SELECTION);
    this.clearPointedElement();
    this.hoveredElement = null;

    this.triggerKeyService.unregisterListeners();

    logger.info('⏸️ Element pointer disabled');
  }

  private startPointing(): void {
    if (this.pointing) return;

    this.triggerMouseService.registerListeners();

    // document cursor pointer
    document.body.classList.add(POINTING_CLASS);

    this.pointing = true;
    logger.debug('Pointing started');
  }

  private stopPointing(): void {
    if (!this.pointing) return;

    this.triggerMouseService.unregisterListeners();
    this.overlayManagerService.clearOverlay(OverlayType.HOVER);

    // document cursor pointer
    document.body.classList.remove(POINTING_CLASS);

    this.pointing = false;
    logger.debug('Pointing stopped');
  }

  private sendToBackground(target: HTMLElement): void {
    logger.info('📤 Sending target to background:', target);

    // Store metadata for screenshot feature
    this.pointedElementMetadata = {
      selector: this.generateSelector(target),
      timestamp: Date.now(),
    };

    // Send directly to background script (isolated world has chrome.runtime access)
    chrome.runtime.sendMessage({
      type: 'DOM_ELEMENT_POINTED',
      data: extractRawPointedDOMElement(target) as RawPointedDOMElement,
    }, (response: any) => {
      if (chrome.runtime.lastError) {
        logger.error('❌ Error sending to background:', chrome.runtime.lastError);
      } else {
        logger.debug('✅ Element sent successfully:', response);
      }
    });
  }

  /**
   * Get the last pointed element for screenshot capture
   * Returns null if no element has been pointed or if element is no longer in DOM
   */
  public getLastPointedElement(): HTMLElement | null {
    if (!this.pointedElement) {
      return null;
    }

    // Check if element is still in the DOM
    if (!document.contains(this.pointedElement)) {
      logger.warn('⚠️ Last pointed element is no longer in the DOM');
      this.clearPointedElement();
      return null;
    }

    return this.pointedElement;
  }

  /**
   * Get metadata about the last pointed element
   */
  public getLastPointedElementMetadata(): { selector: string; timestamp: number } | null {
    return this.pointedElementMetadata;
  }

  /**
   * Clear the pointed element reference
   */
  public clearPointedElement(): void {
    this.pointedElement = null;
    this.pointedElementMetadata = null;
  }

  /**
   * Generate a CSS selector for an element
   */
  private generateSelector(element: HTMLElement): string {
    if (element.id) {
      return `#${element.id}`;
    }

    const path: string[] = [];
    let current: Element | null = element;

    while (current && current.nodeType === Node.ELEMENT_NODE) {
      let selector = current.nodeName.toLowerCase();

      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c && !c.startsWith('mcp-pointer'));
        if (classes.length > 0) {
          selector += '.' + classes.slice(0, 2).join('.');
        }
      }

      path.unshift(selector);

      if (current.id) {
        break;
      }

      current = current.parentElement;

      if (path.length > 5) break; // Limit depth
    }

    return path.join(' > ');
  }
}
