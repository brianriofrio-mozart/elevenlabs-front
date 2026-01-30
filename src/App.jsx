import { useEffect, useRef, useState } from "react";
import './App.css';

export default function RealtimeSTT() {
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioWorkletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const chatContainerRef = useRef(null);
  
  // 🔊 Para reproducción de PCM - MEJORADO
  const ttsAudioContextRef = useRef(null);
  const ttsGainNodeRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const pcmBufferRef = useRef([]);
  const isPlayingRef = useRef(false);
  const leftoverBytesRef = useRef(new Uint8Array(0)); // 🆕 Mejor manejo
  const currentTTSRef = useRef(false);
  const expectedSampleRateRef = useRef(24000); // 🆕 Track sample rate
  
  // 🆕 Para controlar las fuentes de audio activas
  const activeSourcesRef = useRef([]);
  
  const [partial, setPartial] = useState("");
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [agentText, setAgentText] = useState("");
  const [audioError, setAudioError] = useState(null);
  const [ttsFormat, setTtsFormat] = useState(null);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [audioStats, setAudioStats] = useState(null);

  // 🆕 Auto-scroll al último mensaje
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
    }
  }, [messages, agentText, thinking]);

  // 🆕 FUNCIÓN PARA DETENER TODO EL AUDIO
  const stopAllAudio = () => {
    console.log("🛑 Stopping all audio playback");
    
    activeSourcesRef.current.forEach(source => {
      try {
        source.stop();
        source.disconnect();
      } catch (err) {
        // Ignorar errores si ya está detenido
      }
    });
    
    activeSourcesRef.current = [];
    pcmBufferRef.current = [];
    
    if (ttsAudioContextRef.current) {
      nextPlayTimeRef.current = ttsAudioContextRef.current.currentTime;
    }
    
    leftoverBytesRef.current = new Uint8Array(0); // 🆕 Reset limpio
    setIsAgentSpeaking(false);
    currentTTSRef.current = false;
    isPlayingRef.current = false;
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: "stop_tts" }));
    }
  };

  // 🆕 FUNCIÓN MEJORADA PARA REPRODUCIR PCM
  const playPCMChunk = (pcmData, sampleRate = 24000) => {
    const audioContext = ttsAudioContextRef.current;
    if (!audioContext) {
      console.error("❌ No TTS AudioContext available");
      return;
    }

    try {
      // Convertir a Uint8Array si viene como ArrayBuffer
      let uint8Data = pcmData instanceof ArrayBuffer 
        ? new Uint8Array(pcmData)
        : new Uint8Array(pcmData.buffer || pcmData);

      // 🆕 Combinar con leftover bytes previos
      if (leftoverBytesRef.current.length > 0) {
        const combined = new Uint8Array(leftoverBytesRef.current.length + uint8Data.length);
        combined.set(leftoverBytesRef.current, 0);
        combined.set(uint8Data, leftoverBytesRef.current.length);
        uint8Data = combined;
        leftoverBytesRef.current = new Uint8Array(0);
      }

      // 🆕 Verificar alineación a 16-bit (debe ser par)
      if (uint8Data.length % 2 !== 0) {
        console.warn(`⚠️ Unaligned PCM chunk: ${uint8Data.length} bytes. Saving last byte.`);
        leftoverBytesRef.current = new Uint8Array([uint8Data[uint8Data.length - 1]]);
        uint8Data = uint8Data.slice(0, -1);
      }

      // Si no hay datos después de alinear, salir
      if (uint8Data.length === 0) {
        return;
      }

      // 🆕 Validar tamaño mínimo (evitar chunks muy pequeños que causan glitches)
      const MIN_SAMPLES = 256; // ~10ms @ 24kHz
      const numSamples = uint8Data.length / 2;
      
      if (numSamples < MIN_SAMPLES) {
        console.warn(`⚠️ Chunk too small (${numSamples} samples), buffering...`);
        leftoverBytesRef.current = uint8Data;
        return;
      }

      // Convertir Int16 → Float32
      const int16View = new Int16Array(uint8Data.buffer, uint8Data.byteOffset, uint8Data.length / 2);
      const float32Data = new Float32Array(int16View.length);
      
      for (let i = 0; i < int16View.length; i++) {
        // Normalización mejorada con dithering
        const sample = int16View[i] / 32768.0;
        float32Data[i] = Math.max(-1.0, Math.min(1.0, sample));
      }

      // 🆕 Validar que no hay NaN o Infinity
      const hasInvalidSamples = float32Data.some(s => !isFinite(s));
      if (hasInvalidSamples) {
        console.error("❌ Invalid samples detected (NaN/Infinity), skipping chunk");
        return;
      }

      // Crear AudioBuffer
      const audioBuffer = audioContext.createBuffer(1, float32Data.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Data);

      // Crear source y conectar
      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNodeRef.current);

      const now = audioContext.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      
      // 🆕 Detectar gap (si hay silencio no intencional)
      const gap = startTime - now;
      if (gap > 0.1) { // > 100ms gap
        console.warn(`⚠️ Audio gap detected: ${(gap * 1000).toFixed(0)}ms`);
      }

      activeSourcesRef.current.push(source);
      
      source.onended = () => {
        const index = activeSourcesRef.current.indexOf(source);
        if (index > -1) {
          activeSourcesRef.current.splice(index, 1);
        }
      };
      
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
      
    } catch (err) {
      console.error("❌ Error playing PCM:", err);
      setAudioError(`Audio playback error: ${err.message}`);
    }
  };

  // 🆕 COLA DE REPRODUCCIÓN MEJORADA
  const processPCMQueue = () => {
    if (pcmBufferRef.current.length === 0 || isPlayingRef.current) {
      return;
    }

    isPlayingRef.current = true;
    
    try {
      while (pcmBufferRef.current.length > 0) {
        const chunk = pcmBufferRef.current.shift();
        
        // Validar sample rate
        if (chunk.sampleRate !== expectedSampleRateRef.current) {
          console.warn(`⚠️ Sample rate mismatch: expected ${expectedSampleRateRef.current}, got ${chunk.sampleRate}`);
        }
        
        playPCMChunk(chunk.data, chunk.sampleRate);
      }
    } catch (err) {
      console.error("❌ Error processing PCM queue:", err);
    } finally {
      isPlayingRef.current = false;
    }
  };

  // Inicializar WebSocket y TTS AudioContext
  useEffect(() => {
    wsRef.current = new WebSocket("wss://elevenlabs-stt-tts.onrender.com");

    const ttsContext = new AudioContext();
    ttsAudioContextRef.current = ttsContext;
    
    const gainNode = ttsContext.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(ttsContext.destination);
    ttsGainNodeRef.current = gainNode;

    console.log("🎧 TTS AudioContext initialized");

    wsRef.current.onmessage = (event) => {
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then((buffer) => {
          const sampleRate = ttsFormat?.sampleRate || 24000;
          
          // 🆕 Validar que el buffer no esté vacío
          if (buffer.byteLength === 0) {
            console.warn("⚠️ Received empty audio buffer");
            return;
          }

          // 🆕 Validar que el buffer esté alineado
          if (buffer.byteLength % 2 !== 0) {
            console.warn(`⚠️ Received unaligned buffer: ${buffer.byteLength} bytes`);
          }
          
          pcmBufferRef.current.push({
            data: buffer,
            sampleRate: sampleRate
          });

          processPCMQueue();
        }).catch(err => {
          console.error("❌ Error converting blob to buffer:", err);
        });

        return;
      }

      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "partial") {
          setPartial(msg.data.text || "");
        }

        if (msg.type === "final") {
          const userText = msg.data.text.trim();
          if (userText) {
            setMessages(prev => [...prev, {
              id: Date.now(),
              type: 'user',
              text: userText,
              timestamp: new Date()
            }]);
          }
          setPartial("");
        }

        if (msg.type === "thinking") {
          setThinking(true);
          setAgentText("");
        }

        if (msg.type === "agent_text") {
          setThinking(false);
          setAgentText(msg.text);
        }

        if (msg.type === "agent_text_chunk") {
          setThinking(false);
          setAgentText(msg.accumulated);
        }

        if (msg.type === "agent_complete") {
          console.log("✅ Agent response complete");
          
          if (msg.text && msg.text.trim()) {
            setMessages(prev => [...prev, {
              id: Date.now(),
              type: 'agent',
              text: msg.text.trim(),
              timestamp: new Date()
            }]);
          }
          
          setAgentText("");
        }

        if (msg.type === "tts_audio_start") {
          console.log("🎬 TTS audio starting");
          
          const format = {
            format: msg.format,
            sampleRate: msg.sampleRate,
            channels: msg.channels,
            bitDepth: msg.bitDepth
          };
          
          setTtsFormat(format);
          expectedSampleRateRef.current = msg.sampleRate; // 🆕 Track expected rate
          
          currentTTSRef.current = true;
          setIsAgentSpeaking(true);
          
          // 🆕 Limpiar estado previo
          leftoverBytesRef.current = new Uint8Array(0);
          
          if (ttsAudioContextRef.current && nextPlayTimeRef.current <= ttsAudioContextRef.current.currentTime) {
            nextPlayTimeRef.current = ttsAudioContextRef.current.currentTime;
          }
        }

        if (msg.type === "tts_audio_end") {
          console.log("🏁 TTS audio ended");
          currentTTSRef.current = false;
          
          // 🆕 Procesar cualquier leftover final
          if (leftoverBytesRef.current.length >= 2) {
            console.log(`🔊 Processing final leftover: ${leftoverBytesRef.current.length} bytes`);
            playPCMChunk(leftoverBytesRef.current, expectedSampleRateRef.current);
            leftoverBytesRef.current = new Uint8Array(0);
          }
          
          setTimeout(() => {
            if (activeSourcesRef.current.length === 0) {
              setIsAgentSpeaking(false);
            }
          }, 100);
        }

        if (msg.type === "error") {
          console.error("❌ Server error:", msg.error);
          setAudioError(msg.error);
        }

      } catch (err) {
        console.error("❌ Error parsing JSON:", err);
      }
    };

    wsRef.current.onerror = (err) => {
      console.error("❌ WebSocket error:", err);
      setAudioError("WebSocket connection error");
    };

    wsRef.current.onclose = () => {
      console.log("🔌 WebSocket closed");
    };

    return () => {
      console.log("🧹 Cleaning up...");
      
      stopAllAudio();
      
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      
      if (ttsAudioContextRef.current) {
        ttsAudioContextRef.current.close();
        ttsAudioContextRef.current = null;
      }
      
      ttsGainNodeRef.current = null;
      pcmBufferRef.current = [];
      nextPlayTimeRef.current = 0;
      leftoverBytesRef.current = new Uint8Array(0);
    };
  }, []);

  const startRecording = async () => {
    try {
      setAudioError(null);
      setIsRecording(true);

      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          googNoiseSuppression: true,
          googHighpassFilter: true,
          googTypingNoiseDetection: true
        } 
      });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      await audioContext.audioWorklet.addModule('/audio-recorder-worklet.js');
      
      const workletNode = new AudioWorkletNode(audioContext, 'audio-recorder-processor');
      audioWorkletNodeRef.current = workletNode;

      const source = audioContext.createMediaStreamSource(stream);
      source.connect(workletNode);

      workletNode.port.onmessage = (event) => {
        const { type, data } = event.data;

        if (type === 'audioData') {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(data);
          }
        } 
        else if (type === 'silenceDetected') {
          console.log(`🔕 Silencio detectado (${event.data.duration.toFixed(0)}ms) → auto commit`);
          
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({ event: "stop" }));
          }
          
          workletNode.port.postMessage({ type: 'reset' });
        }
        else if (type === 'stats') {
          setAudioStats({
            averageRMS: event.data.averageRMS.toFixed(4),
            silenceFrames: event.data.silenceFrames,
          });
        }
      };

      console.log("🎙️ Recording started with AudioWorklet");
    } catch (err) {
      console.error("❌ Error al acceder al micrófono:", err);
      setAudioError(err.message);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (audioWorkletNodeRef.current) {
      audioWorkletNodeRef.current.disconnect();
      audioWorkletNodeRef.current.port.close();
      audioWorkletNodeRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: "stop" }));
    }
    
    setIsRecording(false);
    setAudioStats(null);
    console.log("⏹️ Recording stopped");
  };

  return (
    <div className="chat-container">
      {/* HEADER */}
      <div className="chat-header">
        <div className="header-title">
          <span className="header-icon">🤖</span>
          <h1>Voice Chat Assistant</h1>
        </div>
        <div className="header-status">
          {isRecording && (
            <span className="status-badge recording">
              <span className="recording-dot"></span>
              Grabando
            </span>
          )}
          {isAgentSpeaking && (
            <span className="status-badge speaking">
              <span className="speaking-wave"></span>
              Reproduciendo
            </span>
          )}
        </div>
      </div>

      {/* CHAT MESSAGES */}
      <div className="chat-messages" ref={chatContainerRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p>Presiona "Iniciar" y comienza a hablar</p>
          </div>
        )}

        {messages.map((message) => (
          <div 
            key={message.id} 
            className={`message ${message.type === 'user' ? 'message-user' : 'message-agent'}`}
          >
            <div className="message-avatar">
              {message.type === 'user' ? '👤' : '🤖'}
            </div>
            <div className="message-content">
              <div className="message-text">{message.text}</div>
              <div className="message-time">
                {message.timestamp.toLocaleTimeString('es-ES', { 
                  hour: '2-digit', 
                  minute: '2-digit' 
                })}
              </div>
            </div>
          </div>
        ))}

        {partial && (
          <div className="message message-user message-partial">
            <div className="message-avatar">👤</div>
            <div className="message-content">
              <div className="message-text">{partial}</div>
              <div className="message-time typing-indicator">escribiendo...</div>
            </div>
          </div>
        )}

        {thinking && (
          <div className="message message-agent">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="thinking-animation">
                <span></span>
                <span></span>
                <span></span>
              </div>
            </div>
          </div>
        )}

        {agentText && !thinking && (
          <div className="message message-agent message-streaming">
            <div className="message-avatar">🤖</div>
            <div className="message-content">
              <div className="message-text">{agentText}</div>
              <div className="message-time">
                <span className="streaming-indicator">●</span> en vivo
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ERROR DISPLAY */}
      {audioError && (
        <div className="error-banner">
          <span className="error-icon">⚠️</span>
          <span className="error-text">{audioError}</span>
          <button 
            className="error-close"
            onClick={() => setAudioError(null)}
          >
            ×
          </button>
        </div>
      )}

      {/* CONTROLS */}
      <div className="chat-controls">
        <button 
          className={`control-btn ${isRecording ? 'btn-recording' : 'btn-start'}`}
          onClick={isRecording ? stopRecording : startRecording}
        >
          {isRecording ? (
            <>
              <span className="btn-icon">⏹️</span>
              Detener
            </>
          ) : (
            <>
              <span className="btn-icon">🎙️</span>
              Iniciar
            </>
          )}
        </button>

        <button 
          className="control-btn btn-stop-audio"
          onClick={stopAllAudio}
          disabled={!isAgentSpeaking}
        >
          <span className="btn-icon">🔇</span>
          Silenciar
        </button>
      </div>

      {/* DEBUG INFO */}
      <div className="debug-info">
        {ttsFormat && (
          <span>
            TTS: {ttsFormat.format?.toUpperCase()} @ {ttsFormat.sampleRate}Hz
          </span>
        )}
        {audioStats && isRecording && (
          <span style={{ marginLeft: '1rem' }}>
            RMS: {audioStats.averageRMS} | Silence: {audioStats.silenceFrames}
          </span>
        )}
        {leftoverBytesRef.current.length > 0 && (
          <span style={{ marginLeft: '1rem', color: '#ff9800' }}>
            Buffer: {leftoverBytesRef.current.length}B
          </span>
        )}
      </div>
    </div>
  );
}