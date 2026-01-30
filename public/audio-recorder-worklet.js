/**
 * AudioWorklet Processor para captura de audio en tiempo real
 * Procesa audio a 16kHz y detecta silencio de forma eficiente
 */

class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Configuración de detección de silencio
    this.silenceThreshold = 0.01;
    this.silenceDurationMs = 400;
    this.silenceFrameCount = 0;
    this.silenceFrameThreshold = 0;
    this.hasCommitted = false;
    
    // Buffer para acumular samples
    this.bufferSize = 1024;
    this.buffer = new Float32Array(this.bufferSize);
    this.bufferIndex = 0;
    
    // Estadísticas de audio
    this.frameCount = 0;
    this.totalEnergy = 0;
    
    // Escuchar mensajes desde el main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'updateConfig') {
        this.silenceThreshold = event.data.silenceThreshold || this.silenceThreshold;
        this.silenceDurationMs = event.data.silenceDurationMs || this.silenceDurationMs;
        this.updateSilenceThreshold();
      } else if (event.data.type === 'reset') {
        this.resetSilenceDetection();
      }
    };
    
    // Calcular threshold de frames basado en sample rate
    this.updateSilenceThreshold();
  }
  
  updateSilenceThreshold() {
    // A 16kHz, 128 samples por frame
    // silenceDurationMs / (128/16000 * 1000) = frames necesarios
    const msPerFrame = (128 / 16000) * 1000; // ~8ms por frame
    this.silenceFrameThreshold = Math.ceil(this.silenceDurationMs / msPerFrame);
  }
  
  resetSilenceDetection() {
    this.silenceFrameCount = 0;
    this.hasCommitted = false;
  }
  
  /**
   * Calcula RMS (Root Mean Square) para detectar nivel de audio
   */
  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }
  
  /**
   * Convierte Float32Array a Int16Array (PCM 16-bit)
   */
  floatTo16BitPCM(float32Array) {
    const buffer = new ArrayBuffer(float32Array.length * 2);
    const view = new DataView(buffer);
    
    let offset = 0;
    for (let i = 0; i < float32Array.length; i++, offset += 2) {
      const sample = Math.max(-1, Math.min(1, float32Array[i]));
      const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset, int16, true); // little-endian
    }
    
    return buffer;
  }
  
  /**
   * Procesa cada frame de audio (128 samples a 16kHz)
   */
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    
    // Si no hay input, continuar procesando
    if (!input || !input[0]) {
      return true;
    }
    
    const inputChannel = input[0]; // Mono channel
    this.frameCount++;
    
    // Calcular RMS del frame actual
    const rms = this.calculateRMS(inputChannel);
    this.totalEnergy += rms;
    
    // Agregar samples al buffer
    for (let i = 0; i < inputChannel.length; i++) {
      this.buffer[this.bufferIndex++] = inputChannel[i];
      
      // Cuando el buffer está lleno, enviarlo
      if (this.bufferIndex >= this.bufferSize) {
        // Convertir a PCM 16-bit
        const pcm16 = this.floatTo16BitPCM(this.buffer);
        
        // Enviar al main thread
        this.port.postMessage({
          type: 'audioData',
          data: pcm16,
          rms: rms,
        }, [pcm16]); // Transferible para mejor performance
        
        // Reset buffer
        this.bufferIndex = 0;
      }
    }
    
    // Detección de silencio
    if (rms < this.silenceThreshold) {
      this.silenceFrameCount++;
      
      // Si alcanzamos el umbral de silencio y no hemos hecho commit
      if (this.silenceFrameCount >= this.silenceFrameThreshold && !this.hasCommitted) {
        this.port.postMessage({
          type: 'silenceDetected',
          duration: (this.silenceFrameCount * 128) / 16000 * 1000, // en ms
        });
        this.hasCommitted = true;
      }
    } else {
      // Hay sonido, resetear contador
      if (this.silenceFrameCount > 0) {
        this.silenceFrameCount = 0;
        this.hasCommitted = false;
      }
    }
    
    // Enviar estadísticas cada segundo (~122 frames a 16kHz)
    if (this.frameCount % 125 === 0) {
      const avgEnergy = this.totalEnergy / 125;
      this.port.postMessage({
        type: 'stats',
        averageRMS: avgEnergy,
        silenceFrames: this.silenceFrameCount,
      });
      this.totalEnergy = 0;
    }
    
    // Continuar procesando
    return true;
  }
}

// Registrar el processor
registerProcessor('audio-recorder-processor', AudioRecorderProcessor);