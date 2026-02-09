import { useEffect, useRef, useState } from "react";
import './App.css';

export default function RealtimeSTT() {
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioWorkletNodeRef = useRef(null);
  const streamRef = useRef(null);
  const chatContainerRef = useRef(null);
  
  // 🔊 Para reproducción de PCM
  const ttsAudioContextRef = useRef(null);
  const ttsGainNodeRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const pcmBufferRef = useRef([]);
  const isPlayingRef = useRef(false);
  const leftoverBytesRef = useRef(new Uint8Array(0));
  const currentTTSRef = useRef(false);
  const expectedSampleRateRef = useRef(24000);
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
  const [textInput, setTextInput] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  
  // 🆕 Estados para manejar el "spin down"
  const [connectionStatus, setConnectionStatus] = useState('disconnected'); // disconnected | connecting | initializing | ready | failed
  const [connectionMessage, setConnectionMessage] = useState('');
  const reconnectTimeoutRef = useRef(null);
  const maxReconnectAttempts = 3;
  const reconnectAttemptRef = useRef(0);

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
    
    leftoverBytesRef.current = new Uint8Array(0);
    setIsAgentSpeaking(false);
    currentTTSRef.current = false;
    isPlayingRef.current = false;
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: "stop_tts" }));
    }
  };

  // 🆕 FUNCIÓN PARA VERIFICAR SI EL BACKEND ESTÁ LISTO
  const checkBackendHealth = async () => {
    try {
      const response = await fetch('https://elevenlabs-stt-tts.onrender.com/health');
      return response.ok;
    } catch (error) {
      console.log('Backend not ready yet:', error.message);
      return false;
    }
  };

  // 🆕 FUNCIÓN PARA ESPERAR QUE EL BACKEND ESTÉ LISTO
  const waitForBackend = async (maxAttempts = 30) => {
    setConnectionStatus('connecting');
    setConnectionMessage('Verificando servidor...');
    
    for (let i = 0; i < maxAttempts; i++) {
      const isReady = await checkBackendHealth();
      
      if (isReady) {
        console.log('✅ Backend is ready');
        return true;
      }
      
      const secondsRemaining = Math.ceil((maxAttempts - i) * 2);
      setConnectionMessage(`Esperando servidor... (${secondsRemaining}s)`);
      
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    return false;
  };

  // 🆕 FUNCIÓN MEJORADA PARA REPRODUCIR PCM
  const playPCMChunk = (pcmData, sampleRate = 24000) => {
    const audioContext = ttsAudioContextRef.current;
    if (!audioContext) {
      console.error("❌ No TTS AudioContext available");
      return;
    }

    try {
      let uint8Data = pcmData instanceof ArrayBuffer 
        ? new Uint8Array(pcmData)
        : new Uint8Array(pcmData.buffer || pcmData);

      if (leftoverBytesRef.current.length > 0) {
        const combined = new Uint8Array(leftoverBytesRef.current.length + uint8Data.length);
        combined.set(leftoverBytesRef.current, 0);
        combined.set(uint8Data, leftoverBytesRef.current.length);
        uint8Data = combined;
        leftoverBytesRef.current = new Uint8Array(0);
      }

      if (uint8Data.length % 2 !== 0) {
        leftoverBytesRef.current = new Uint8Array([uint8Data[uint8Data.length - 1]]);
        uint8Data = uint8Data.slice(0, -1);
      }

      if (uint8Data.length === 0) {
        return;
      }

      const MIN_SAMPLES = 256;
      const numSamples = uint8Data.length / 2;
      
      if (numSamples < MIN_SAMPLES) {
        leftoverBytesRef.current = uint8Data;
        return;
      }

      const int16View = new Int16Array(uint8Data.buffer, uint8Data.byteOffset, uint8Data.length / 2);
      const float32Data = new Float32Array(int16View.length);
      
      for (let i = 0; i < int16View.length; i++) {
        const sample = int16View[i] / 32768.0;
        float32Data[i] = Math.max(-1.0, Math.min(1.0, sample));
      }

      const hasInvalidSamples = float32Data.some(s => !isFinite(s));
      if (hasInvalidSamples) {
        console.error("❌ Invalid samples detected (NaN/Infinity), skipping chunk");
        return;
      }

      const audioBuffer = audioContext.createBuffer(1, float32Data.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNodeRef.current);

      const now = audioContext.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      
      const gap = startTime - now;
      if (gap > 0.1) {
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

  // 🆕 COLA DE REPRODUCCIÓN
  const processPCMQueue = () => {
    if (pcmBufferRef.current.length === 0 || isPlayingRef.current) {
      return;
    }

    isPlayingRef.current = true;
    
    try {
      while (pcmBufferRef.current.length > 0) {
        const chunk = pcmBufferRef.current.shift();
        
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

  // 🆕 FUNCIÓN PARA CONECTAR WEBSOCKET CON REINTENTOS
  const connectWebSocket = async () => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      console.log('WebSocket already connected');
      return;
    }

    // Primero verificar que el backend esté listo
    const backendReady = await waitForBackend();
    
    if (!backendReady) {
      setConnectionStatus('failed');
      setConnectionMessage('No se pudo conectar al servidor. El servidor puede estar iniciando.');
      setAudioError('Servidor no disponible. Por favor intenta de nuevo en 1 minuto.');
      return;
    }

    // Ahora sí, conectar WebSocket
    setConnectionStatus('initializing');
    setConnectionMessage('Conectando al servicio de voz...');

    try {
      const ws = new WebSocket("wss://elevenlabs-stt-tts.onrender.com");
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('🔗 WebSocket connected, waiting for service ready...');
        reconnectAttemptRef.current = 0;
      };

      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          event.data.arrayBuffer().then((buffer) => {
            const sampleRate = ttsFormat?.sampleRate || 24000;
            
            if (buffer.byteLength === 0) {
              console.warn("⚠️ Received empty audio buffer");
              return;
            }

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

          // 🆕 MANEJAR ESTADOS DE CONEXIÓN
          if (msg.type === "initializing") {
            setConnectionStatus('initializing');
            setConnectionMessage(msg.message || 'Inicializando servicio...');
            console.log('⏳ Service initializing...');
          }

          if (msg.type === "ready") {
            setConnectionStatus('ready');
            setConnectionMessage('');
            setAudioError(null);
            console.log('✅ Service ready!');
          }

          if (msg.type === "connection_failed") {
            setConnectionStatus('failed');
            setConnectionMessage('');
            setAudioError(msg.error || 'No se pudo conectar al servicio');
            console.error('❌ Connection failed:', msg.error);
          }

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
            setAgentText(""); // Limpiamos para la nueva respuesta
          }

          if (msg.type === "agent_text") {
            setThinking(false);
            setAgentText(msg.text);
          }

          if (msg.type === "agent_text_chunk") {
            setThinking(false);
            // Solo actualizamos si el nuevo texto acumulado es realmente más largo 
            // que el que ya tenemos, y usamos siempre la versión limpia.
            setAgentText(prev => {
              const newText = msg.accumulated || "";
              if (newText.length > prev.length) {
                return newText;
              }
              return prev;
            });
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
            expectedSampleRateRef.current = msg.sampleRate;
            
            currentTTSRef.current = true;
            setIsAgentSpeaking(true);
            
            leftoverBytesRef.current = new Uint8Array(0);
            
            if (ttsAudioContextRef.current && nextPlayTimeRef.current <= ttsAudioContextRef.current.currentTime) {
              nextPlayTimeRef.current = ttsAudioContextRef.current.currentTime;
            }
          }

          if (msg.type === "tts_audio_end") {
            console.log("🏁 TTS audio ended");
            currentTTSRef.current = false;
            
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

      ws.onerror = (err) => {
        console.error("❌ WebSocket error:", err);
        setConnectionStatus('failed');
        setAudioError("Error de conexión WebSocket");
      };

      ws.onclose = () => {
        console.log("🔌 WebSocket closed");
        setConnectionStatus('disconnected');
        
        // 🆕 Intentar reconectar si no fue cierre intencional
        if (reconnectAttemptRef.current < maxReconnectAttempts) {
          reconnectAttemptRef.current++;
          console.log(`🔄 Attempting to reconnect (${reconnectAttemptRef.current}/${maxReconnectAttempts})...`);
          
          reconnectTimeoutRef.current = setTimeout(() => {
            connectWebSocket();
          }, 3000);
        } else {
          setAudioError('Conexión perdida. Por favor recarga la página.');
        }
      };

    } catch (error) {
      console.error('❌ Error connecting WebSocket:', error);
      setConnectionStatus('failed');
      setAudioError('No se pudo conectar al servidor');
    }
  };

const handleSendText = (e) => {
  e.preventDefault();
  if (!textInput.trim() || connectionStatus !== 'ready') return;

  // 1. IMPORTANTE: Detener audio actual para que no se traslapen las voces
  stopAllAudio(); 

  // 2. Reiniciar estados visuales inmediatamente
  setThinking(true);
  setAgentText(""); 
  setPartial(""); // Limpia transcripciones de voz residuales

  // 3. Enviar el mensaje
  if (wsRef.current?.readyState === WebSocket.OPEN) {
    wsRef.current.send(JSON.stringify({ 
      type: "text_input", 
      text: textInput.trim() 
    }));
  }

  // 4. Agregar a la lista de mensajes
  setMessages(prev => [...prev, {
    id: Date.now(),
    type: 'user',
    text: textInput.trim(),
    timestamp: new Date()
  }]);

  setTextInput("");
  };

  // 🆕 Inicializar WebSocket y TTS AudioContext con verificación
  useEffect(() => {
    // Inicializar TTS AudioContext
    const ttsContext = new AudioContext();
    ttsAudioContextRef.current = ttsContext;
    
    const gainNode = ttsContext.createGain();
    gainNode.gain.value = 1.0;
    gainNode.connect(ttsContext.destination);
    ttsGainNodeRef.current = gainNode;

    console.log("🎧 TTS AudioContext initialized");

    // Conectar WebSocket con verificación
    connectWebSocket();

    return () => {
      console.log("🧹 Cleaning up...");
      
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      
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
    // 🆕 Verificar que esté conectado antes de grabar
    if (connectionStatus !== 'ready') {
      setAudioError('Esperando conexión al servicio...');
      return;
    }

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
          {/* 🆕 Mostrar estado de conexión */}
          {connectionStatus === 'connecting' && (
            <span className="status-badge connecting">
              <span className="connecting-dot"></span>
              Conectando...
            </span>
          )}
          {connectionStatus === 'initializing' && (
            <span className="status-badge initializing">
              <span className="connecting-dot"></span>
              Inicializando...
            </span>
          )}
          {connectionStatus === 'ready' && !isRecording && !isAgentSpeaking && (
            <span className="status-badge ready">
              ✓ Listo
            </span>
          )}
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

      {/* 🆕 MENSAJE DE CONEXIÓN */}
      {connectionMessage && (
        <div className="connection-banner">
          <span className="connection-icon">⏳</span>
          <span className="connection-text">{connectionMessage}</span>
        </div>
      )}

      {/* CHAT MESSAGES */}
      <div className="chat-messages" ref={chatContainerRef}>
        {messages.length === 0 && (
          <div className="empty-state">
            <div className="empty-icon">💬</div>
            <p>
              {connectionStatus === 'ready' 
                ? 'Presiona "Iniciar" y comienza a hablar'
                : 'Esperando conexión...'}
            </p>
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
      <div className="chat-controls-container">
        {/* Nuevo formulario de texto */}
        <form className="text-input-form" onSubmit={handleSendText}>
          <input 
            type="text"
            className="chat-input-field"
            placeholder="Escribe un mensaje..."
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            disabled={connectionStatus !== 'ready'}
          />
          <button type="submit" className="btn-send" disabled={!textInput.trim() || connectionStatus !== 'ready'}>
            <span style={{ fontSize: '18px' }}>➤</span>
          </button>
        </form>

        {/* Controles de voz originales */}
        <div className="chat-controls" style={{ paddingTop: 0 }}>
          <button 
            className={`control-btn ${isRecording ? 'btn-recording' : 'btn-start'}`}
            onClick={isRecording ? stopRecording : startRecording}
            disabled={connectionStatus !== 'ready'}
          >
            {isRecording ? (
              <>
                <span className="btn-icon">⏹️</span>
                Detener
              </>
            ) : (
              <>
                <span className="btn-icon">🎙️</span>
                {connectionStatus === 'ready' ? 'Iniciar' : 'Conectando...'}
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
      </div>

      {/* DEBUG INFO */}
      <div className="debug-info">
        <span>Estado: {connectionStatus}</span>
        {ttsFormat && (
          <span style={{ marginLeft: '1rem' }}>
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