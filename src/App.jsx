import { useEffect, useRef, useState } from "react";
import './App.css';

export default function RealtimeSTT() {
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const chatContainerRef = useRef(null);
  
  // 🔊 Para reproducción de PCM
  const ttsAudioContextRef = useRef(null);
  const ttsGainNodeRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const pcmBufferRef = useRef([]);
  const isPlayingRef = useRef(false);
  const leftoverBytesRef = useRef(null);
  const currentTTSRef = useRef(false);
  
  // 🆕 Para controlar las fuentes de audio activas
  const activeSourcesRef = useRef([]);
  
  const SILENCE_THRESHOLD = 0.01;
  const SILENCE_MS = 400;
  const silenceStartRef = useRef(null);
  const hasCommittedRef = useRef(false);

  const [partial, setPartial] = useState("");
  const [messages, setMessages] = useState([]); // 🆕 Array de mensajes
  const [thinking, setThinking] = useState(false);
  const [agentText, setAgentText] = useState("");
  const [audioError, setAudioError] = useState(null);
  const [ttsFormat, setTtsFormat] = useState(null);
  const [isAgentSpeaking, setIsAgentSpeaking] = useState(false);
  const [isRecording, setIsRecording] = useState(false); // 🆕

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
    
    leftoverBytesRef.current = null;
    setIsAgentSpeaking(false);
    currentTTSRef.current = false;
    isPlayingRef.current = false;
    
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: "stop_tts" }));
    }
  };

  const playPCMChunk = (pcmData, sampleRate = 24000) => {
    const audioContext = ttsAudioContextRef.current;
    if (!audioContext) {
      console.error("❌ No TTS AudioContext available");
      return;
    }

    try {
      let buffer = pcmData;
      
      if (leftoverBytesRef.current) {
        const combined = new Uint8Array(leftoverBytesRef.current.byteLength + buffer.byteLength);
        combined.set(new Uint8Array(leftoverBytesRef.current), 0);
        combined.set(new Uint8Array(buffer), leftoverBytesRef.current.byteLength);
        buffer = combined.buffer;
        leftoverBytesRef.current = null;
      }
      
      if (buffer.byteLength % 2 !== 0) {
        leftoverBytesRef.current = buffer.slice(buffer.byteLength - 1);
        buffer = buffer.slice(0, buffer.byteLength - 1);
      }
      
      if (buffer.byteLength === 0) {
        return;
      }
      
      const int16Data = new Int16Array(buffer);
      const float32Data = new Float32Array(int16Data.length);
      for (let i = 0; i < int16Data.length; i++) {
        float32Data[i] = int16Data[i] / 32768.0;
      }

      const audioBuffer = audioContext.createBuffer(1, float32Data.length, sampleRate);
      audioBuffer.getChannelData(0).set(float32Data);

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ttsGainNodeRef.current);

      const now = audioContext.currentTime;
      const startTime = Math.max(now, nextPlayTimeRef.current);
      
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
      setAudioError(err.message);
    }
  };

  const processPCMQueue = () => {
    if (pcmBufferRef.current.length > 0 && !isPlayingRef.current) {
      isPlayingRef.current = true;
      
      while (pcmBufferRef.current.length > 0) {
        const chunk = pcmBufferRef.current.shift();
        playPCMChunk(chunk.data, chunk.sampleRate);
      }
      
      isPlayingRef.current = false;
    }
  };

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
          
          pcmBufferRef.current.push({
            data: buffer,
            sampleRate: sampleRate
          });

          processPCMQueue();
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
            // 🆕 Agregar mensaje del usuario al chat
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
          
          // 🆕 Agregar mensaje del agente al chat
          if (msg.text && msg.text.trim()) {
            setMessages(prev => [...prev, {
              id: Date.now(),
              type: 'agent',
              text: msg.text.trim(),
              timestamp: new Date()
            }]);
          }
          
          setAgentText(""); // Limpiar texto temporal
        }

        if (msg.type === "tts_audio_start") {
          console.log("🎬 TTS audio starting");
          setTtsFormat({
            format: msg.format,
            sampleRate: msg.sampleRate,
            channels: msg.channels,
            bitDepth: msg.bitDepth
          });
          
          currentTTSRef.current = true;
          setIsAgentSpeaking(true);
          
          if (ttsAudioContextRef.current && nextPlayTimeRef.current <= ttsAudioContextRef.current.currentTime) {
            nextPlayTimeRef.current = ttsAudioContextRef.current.currentTime;
          }
          
          leftoverBytesRef.current = null;
        }

        if (msg.type === "tts_audio_end") {
          console.log("🏁 TTS audio ended");
          currentTTSRef.current = false;
          
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
    };
  }, []);

  const startRecording = async () => {
    try {
      silenceStartRef.current = null;
      hasCommittedRef.current = false;
      setAudioError(null);
      setIsRecording(true);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (e) => {
        const float32Data = e.inputBuffer.getChannelData(0);
        const pcm16 = floatTo16BitPCM(float32Data);

        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcm16);
        }

        let sum = 0;
        for (let i = 0; i < float32Data.length; i++) {
          sum += float32Data[i] * float32Data[i];
        }
        const rms = Math.sqrt(sum / float32Data.length);

        const now = Date.now();

        if (rms < SILENCE_THRESHOLD) {
          if (!silenceStartRef.current) silenceStartRef.current = now;

          if (
            now - silenceStartRef.current > SILENCE_MS &&
            !hasCommittedRef.current &&
            wsRef.current?.readyState === WebSocket.OPEN
          ) {
            console.log("🔕 Silencio detectado → auto commit");
            wsRef.current.send(JSON.stringify({ event: "stop" }));
            hasCommittedRef.current = true;
          }
        } else {
          silenceStartRef.current = null;
          hasCommittedRef.current = false;
        }
      };
      processorRef.current = processor;

      source.connect(processor);
      processor.connect(audioContext.destination);
      
      console.log("🎙️ Recording started");
    } catch (err) {
      console.error("Error al acceder al micrófono:", err);
      setAudioError(err.message);
      setIsRecording(false);
    }
  };

  const stopRecording = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
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

        {/* MENSAJE PARCIAL (mientras hablas) */}
        {partial && (
          <div className="message message-user message-partial">
            <div className="message-avatar">👤</div>
            <div className="message-content">
              <div className="message-text">{partial}</div>
              <div className="message-time typing-indicator">escribiendo...</div>
            </div>
          </div>
        )}

        {/* PENSANDO */}
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

        {/* RESPUESTA EN STREAMING */}
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

      {/* DEBUG INFO (opcional, puedes removerlo) */}
      {ttsFormat && (
        <div className="debug-info">
          {ttsFormat.format?.toUpperCase()} @ {ttsFormat.sampleRate}Hz
        </div>
      )}
    </div>
  );
}

function floatTo16BitPCM(float32Array) {
  const buffer = new ArrayBuffer(float32Array.length * 2);
  const view = new DataView(buffer);

  let offset = 0;
  for (let i = 0; i < float32Array.length; i++, offset += 2) {
    let sample = Math.max(-1, Math.min(1, float32Array[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
  }

  return buffer;
}