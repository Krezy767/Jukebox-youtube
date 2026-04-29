// Worker-side browser shims for libraries that assume a window/document context.
self.window = self;
self.globalThis = self;
self.__ESSENTIA_WASM_URL__ = 'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.wasm';
self.document = self.document || {
  currentScript: { src: '/shadowWorker.js' },
  location: self.location,
  createElement: () => ({ getContext: () => null })
};
self.navigator = self.navigator || { userAgent: 'shadow-worker' };

importScripts(
  'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia-wasm.web.js',
  'https://cdn.jsdelivr.net/npm/essentia.js@0.1.3/dist/essentia.js-core.js',
  '/shadowEngine.js'
);

self.onmessage = async (event) => {
  const { id, pcmData, sampleRate, log } = event.data || {};
  if (!id || !pcmData || !sampleRate) {
    self.postMessage({ id, ok: false, error: 'Missing worker analysis payload' });
    return;
  }

  try {
    const data = pcmData instanceof Float32Array ? pcmData : new Float32Array(pcmData);
    const analysis = await self.shadowEngine.analyzePcmData(data, sampleRate, { log: !!log });
    self.postMessage({ id, ok: true, analysis });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error?.message || String(error) });
  }
};
