/**
 * Detects whether the current browser is running without hardware GPU acceleration
 * (e.g., Linux without a GPU using llvmpipe/SwiftShader/softpipe, or WebGL disabled).
 * Always cleans up its temporary WebGL context immediately to avoid leaking GPU contexts.
 */
export function detectSoftwareRenderer(): boolean {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return false;
  }

  try {
    const testCanvas = document.createElement('canvas');
    testCanvas.width = 1;
    testCanvas.height = 1;

    const gl =
      (testCanvas.getContext('webgl', { failIfMajorPerformanceCaveat: false }) as WebGLRenderingContext | null) ||
      (testCanvas.getContext('experimental-webgl') as WebGLRenderingContext | null);

    if (!gl) {
      return true;
    }

    let rendererStr = '';
    try {
      const debugExt = gl.getExtension('WEBGL_debug_renderer_info');
      if (debugExt) {
        const unmaskedRenderer = gl.getParameter(debugExt.UNMASKED_RENDERER_WEBGL);
        const unmaskedVendor = gl.getParameter(debugExt.UNMASKED_VENDOR_WEBGL);
        rendererStr = `${String(unmaskedVendor || '')} ${String(unmaskedRenderer || '')}`.toLowerCase();
      } else {
        const stdRenderer = gl.getParameter(gl.RENDERER);
        const stdVendor = gl.getParameter(gl.VENDOR);
        rendererStr = `${String(stdVendor || '')} ${String(stdRenderer || '')}`.toLowerCase();
      }
    } catch {
      rendererStr = '';
    } finally {
      try {
        const loseExt = gl.getExtension('WEBGL_lose_context');
        loseExt?.loseContext();
      } catch {
        // ignore cleanup error
      }
    }

    if (!rendererStr) {
      return true;
    }

    return /swiftshader|llvmpipe|softpipe|software|basic render|mesa offscreen|subzero|virtualbox|chromium/.test(
      rendererStr
    );
  } catch {
    return true;
  }
}

/**
 * Acquires a resilient 2D canvas rendering context.
 * Uses `{ alpha: false }` to eliminate costly full-board compositor alpha blending,
 * and enables `willReadFrequently` when no hardware GPU is available so Chromium/Firefox
 * stay on reliable CPU/software Skia 2D rasterization instead of crashing GPU mailboxes.
 */
export function getSafe2DContext(
  canvas: HTMLCanvasElement,
  preferSoftwareRaster: boolean
): CanvasRenderingContext2D | null {
  try {
    const ctx = canvas.getContext('2d', {
      alpha: false,
      willReadFrequently: preferSoftwareRaster,
    });
    if (ctx) return ctx;
  } catch {
    // Fallback below if browser rejects context options
  }

  try {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) return ctx;
  } catch {
    // Fallback below
  }

  try {
    return canvas.getContext('2d');
  } catch {
    return null;
  }
}
