import jsPDF from 'jspdf';
import html2canvas from 'html2canvas';

export interface PdfExportOptions {
  filename: string;
  widthMm: number;
  heightMm: number;
  dpi?: number;
}

/**
 * Parses and sanitizes a style color string to ensure compatibility with traditional PDF/canvas engines.
 * Converts oklch, oklab, lab, lch, and css variables to plain hex monochrome values (#ffffff or #000000).
 */
function sanitizeColor(val: string | null | undefined): string {
  if (!val) return '#000000';
  const clean = val.trim();

  // If none, transparent, or inheritance-friendly keywords, return directly.
  if (clean === 'none' || clean === 'transparent' || clean.startsWith('rgba(0,0,0,0)') || clean.startsWith('rgba(0, 0, 0, 0)')) {
    return clean;
  }

  // Resolve CSS variables from the document element
  if (clean.startsWith('var(')) {
    const match = clean.match(/var\(([^)]+)\)/);
    if (match) {
      const varName = match[1].trim();
      const docStyle = window.getComputedStyle(document.documentElement);
      const resolved = docStyle.getPropertyValue(varName).trim();
      if (resolved) {
        return sanitizeColor(resolved);
      }
    }
  }

  // Convert modern visual color channels (like oklch or lch) to hex black or white
  if (clean.includes('oklab') || clean.includes('oklch') || clean.includes('lab') || clean.includes('lch')) {
    const match = clean.match(/(oklab|oklch|lab|lch)\(([^)]+)\)/i);
    if (match) {
      const type = match[1].toLowerCase();
      const parts = match[2].split(/[\s,\/]+/);
      if (parts.length > 0) {
        const firstPart = parts[0].trim();
        const lVal = parseFloat(firstPart);
        if (!isNaN(lVal)) {
          let L = lVal;
          if (firstPart.includes('%')) {
            L = lVal / 100;
          } else if (type === 'lab' || type === 'lch') {
            L = lVal / 100;
          }
          // Threshold for lighter (white) backgrounds vs darker (black) text
          if (L > 0.82) {
            return '#ffffff';
          }
        }
      }
    }
    return '#000000';
  }

  // Convert legacy RGB or RGBA definitions to monochrome hex
  if (clean.startsWith('rgb')) {
    const rgbMatch = clean.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
      const r = parseInt(rgbMatch[1], 10);
      const g = parseInt(rgbMatch[2], 10);
      const b = parseInt(rgbMatch[3], 10);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      return brightness > 128 ? '#ffffff' : '#000000';
    }
  }

  // Check if standard hex and resolve to monochrome
  if (clean.startsWith('#')) {
    const hex = clean.slice(1);
    let r = 0, g = 0, b = 0;
    if (hex.length === 3) {
      r = parseInt(hex[0] + hex[0], 16);
      g = parseInt(hex[1] + hex[1], 16);
      b = parseInt(hex[2] + hex[2], 16);
    } else if (hex.length === 6) {
      r = parseInt(hex.slice(0, 2), 16);
      g = parseInt(hex.slice(2, 4), 16);
      b = parseInt(hex.slice(4, 6), 16);
    }
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 128 ? '#ffffff' : '#000000';
  }

  const lowerVal = clean.toLowerCase();
  if (['white', 'aliceblue', 'ghostwhite', 'snow', 'ivory', 'floralwhite', 'seashell'].includes(lowerVal)) {
    return '#ffffff';
  }

  return '#000000';
}

/**
 * Deep clones elements while inlining all active computed styles into inline attributes.
 * Eradicates high-definition color keywords, resolving all coordinates to standard hex values.
 */
function cloneAndInlineStyles(sourceEl: any, forceMonochrome: boolean): any {
  const cloned = sourceEl.cloneNode(false) as any;

  if (sourceEl instanceof SVGElement && sourceEl.tagName.toLowerCase() !== 'svg') {
    // SVGs do not use oklch or complex responsive class styling.
    // They are self-contained vector paths. Clone children recursively as-is.
    const children = Array.from(sourceEl.childNodes) as any[];
    for (const child of children) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        cloned.appendChild(cloneAndInlineStyles(child, forceMonochrome));
      } else {
        cloned.appendChild(child.cloneNode(true));
      }
    }
    return cloned;
  }

  // Proceed with HTML element style copying
  const computed = window.getComputedStyle(sourceEl);

  const propertiesToCopy = [
    'display', 'flex-direction', 'justify-content', 'align-items', 'flex-grow', 'flex-shrink',
    'width', 'height', 'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'font-size', 'font-family', 'font-weight', 'line-height', 'text-align', 'text-transform', 'letter-spacing',
    'border-width', 'border-style', 'border-color', 'border-radius',
    'border-top-width', 'border-top-style', 'border-top-color',
    'border-right-width', 'border-right-style', 'border-right-color',
    'border-bottom-width', 'border-bottom-style', 'border-bottom-color',
    'border-left-width', 'border-left-style', 'border-left-color',
    'box-sizing', 'overflow', 'position', 'left', 'top', 'right', 'bottom',
    'transform', 'transform-origin', 'color', 'background-color',
    'fill', 'stroke', 'stroke-width', 'gap', 'flex', 'align-self', 'justify-self', 'align-content',
    'grid-template-columns', 'grid-template-rows'
  ];

  for (const prop of propertiesToCopy) {
    try {
      let val = computed.getPropertyValue(prop);
      if (forceMonochrome) {
        if (prop.includes('color') || prop === 'color' || prop === 'background-color' || prop === 'border-color') {
          val = sanitizeColor(val);
        } else if (prop === 'fill' || prop === 'stroke') {
          val = sanitizeColor(val);
        }
      }
      cloned.style.setProperty(prop, val);
    } catch {
      // Absorb any minor style property write failures
    }
  }

  // Assert absolute hex overrides for baseline colors
  if (forceMonochrome) {
    cloned.style.color = sanitizeColor(computed.color || '#000000');
    cloned.style.backgroundColor = sanitizeColor(computed.backgroundColor || '#ffffff');
    cloned.style.borderColor = sanitizeColor(computed.borderColor || '#000000');
  }

  // Clear class list to isolate elements from stylesheet color rules
  cloned.removeAttribute('class');

  // Stagger child traversal
  const children = Array.from(sourceEl.childNodes) as any[];
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      cloned.appendChild(cloneAndInlineStyles(child, forceMonochrome));
    } else if (child.nodeType === Node.TEXT_NODE) {
      cloned.appendChild(child.cloneNode(true));
    }
  }

  return cloned;
}

export class PdfService {
  /**
   * Captures HTML elements and packages them into a multi-page PDF.
   * Cleanses the cloned DOM from oklch / oklab styling and disables site stylesheets temporarily during html2canvas,
   * guaranteeing that color parsing errors never break the compilation workflow.
   */
  static async exportToPdf(containerId: string, options: PdfExportOptions): Promise<void> {
    const container = document.getElementById(containerId);
    if (!container) {
      throw new Error(`Target container ID "${containerId}" was not found.`);
    }

    const pages = container.querySelectorAll('.print-page-target');
    const targetPages = pages.length > 0 ? Array.from(pages) : [container];
    const { widthMm, heightMm, dpi = 300, filename } = options;

    // 1. Perform clones first while stylesheets are still fully active to capture computed styles exactly as previewed
    const clones: HTMLElement[] = [];
    try {
      for (let i = 0; i < targetPages.length; i++) {
        const originalPage = targetPages[i] as HTMLElement;
        const clone = cloneAndInlineStyles(originalPage, true);
        clones.push(clone);
      }
    } catch (err) {
      console.error('[PdfService] Error cloning styles:', err);
      throw new Error(`Failed to clone layout: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Create a robust hidden container for rendering clones
    const isolatedContainer = document.createElement('div');
    isolatedContainer.style.position = 'absolute';
    isolatedContainer.style.left = '-9999px';
    isolatedContainer.style.top = '-9999px';
    isolatedContainer.style.width = '1000mm';
    isolatedContainer.style.height = '1000mm';
    isolatedContainer.style.backgroundColor = '#ffffff';
    document.body.appendChild(isolatedContainer);

    // Create jsPDF instance
    const pdf = new jsPDF({
      orientation: widthMm >= heightMm ? 'l' : 'p',
      unit: 'mm',
      format: [widthMm, heightMm]
    });

    const disabledSheets: { sheet: CSSStyleSheet; wasDisabled: boolean }[] = [];

    // 2. Clear out class styling from active stylesheet registers to protect html2canvas from color function parses
    for (let s = 0; s < document.styleSheets.length; s++) {
      try {
        const sheet = document.styleSheets[s];
        // Allow Google Fonts or font stylesheets to remain active so fonts compute accurately
        if (sheet.href && (sheet.href.includes('fonts.googleapis.com') || sheet.href.includes('fonts.gstatic.com'))) {
          continue;
        }
        disabledSheets.push({ sheet, wasDisabled: sheet.disabled });
        sheet.disabled = true;
      } catch {
        // Safe check for cross-origin stylesheet exceptions, disable them as a precaution if failure occurs
        try {
          const sheet = document.styleSheets[s];
          disabledSheets.push({ sheet, wasDisabled: sheet.disabled });
          sheet.disabled = true;
        } catch {
          // Safe ignore
        }
      }
    }

    try {
      for (let i = 0; i < clones.length; i++) {
        const clone = clones[i];
        isolatedContainer.appendChild(clone);

        const canvas = await html2canvas(clone, {
          scale: dpi / 96,
          useCORS: true,
          logging: false,
          backgroundColor: '#ffffff'
        });

        // Cleanup clone node immediately to conserve layout memory
        isolatedContainer.removeChild(clone);

        const imgData = canvas.toDataURL('image/png', 1.0);

        if (i > 0) {
          pdf.addPage([widthMm, heightMm], widthMm >= heightMm ? 'l' : 'p');
        }

        pdf.addImage(imgData, 'PNG', 0, 0, widthMm, heightMm);
      }
    } finally {
      // Clean up isolated dom wrapper
      if (isolatedContainer.parentNode) {
        isolatedContainer.parentNode.removeChild(isolatedContainer);
      }

      // Restore stylesheets back to their default active/inactive state
      for (const item of disabledSheets) {
        try {
          item.sheet.disabled = item.wasDisabled;
        } catch {
          // Safe ignore
        }
      }
    }

    pdf.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
  }
}
