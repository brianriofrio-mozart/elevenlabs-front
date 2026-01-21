import { useEffect, useRef, useState } from "react";
import './App.css';

export default function RealtimeSTT() {
  const wsRef = useRef(null);
  const audioContextRef = useRef(null);
  const processorRef = useRef(null);
  const sourceRef = useRef(null);
  const streamRef = useRef(null);
  const mediaSourceRef = useRef(null);
  const sourceBufferRef = useRef(null);
  const audioElementRef = useRef(null);
  const ttsQueueRef = useRef([]);
  const SILENCE_THRESHOLD = 0.01;
  const SILENCE_MS = 400;
  const silenceStartRef = useRef(null);
  const hasCommittedRef = useRef(false);


  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");
  const [thinking, setThinking] = useState(false);
  const [agentText, setAgentText] = useState("");
  const [audioError, setAudioError] = useState(null);

  useEffect(() => {
    wsRef.current = new WebSocket("wss://elevenlabs-stt-tts.onrender.com");

    // 🔊 Audio TTS
    const audio = new Audio();
    audio.autoplay = true;
    audioElementRef.current = audio;

    // Manejo de errores del audio
    audio.addEventListener('error', (e) => {
      console.error("❌ Audio error:", audio.error);
      setAudioError(audio.error?.message || "Error desconocido");
    });

    const mediaSource = new MediaSource();
    mediaSourceRef.current = mediaSource;
    audio.src = URL.createObjectURL(mediaSource);

    mediaSource.addEventListener("sourceopen", () => {
      console.log("🎧 MediaSource open");
      try {
        const sourceBuffer = mediaSource.addSourceBuffer("audio/mpeg");
        console.log("➕ SourceBuffer created");

        sourceBuffer.mode = "sequence";
        sourceBufferRef.current = sourceBuffer;

        sourceBuffer.addEventListener("error", (e) => {
          console.error("❌ SourceBuffer error:", e);
        });

        sourceBuffer.addEventListener("updateend", () => {
          console.log("✅ SourceBuffer updateend");

          if (ttsQueueRef.current.length > 0 && !sourceBuffer.updating) {
            const next = ttsQueueRef.current.shift();
            console.log("➡️ Appending queued chunk", next.byteLength);
            try {
              sourceBuffer.appendBuffer(next);
            } catch (err) {
              console.error("❌ Error appending buffer:", err);
              setAudioError(err.message);
            }
          }
        });
      } catch (err) {
        console.error("❌ Error creating SourceBuffer:", err);
        setAudioError(err.message);
      }
    });

    wsRef.current.onmessage = (event) => {
      // 🔊 AUDIO MP3 STREAMING
      if (event.data instanceof Blob) {
        console.log("📥 MP3 chunk received");

        event.data.arrayBuffer().then((buffer) => {
          const sourceBuffer = sourceBufferRef.current;
          const audio = audioElementRef.current;

          if (!sourceBuffer) {
            console.warn("⚠️ SourceBuffer not ready");
            return;
          }

          // Verificar que el audio no esté en error
          if (audio && audio.error) {
            console.error("❌ Audio element has error, skipping append");
            return;
          }

          // Verificar que MediaSource esté abierto
          if (mediaSourceRef.current?.readyState !== "open") {
            console.warn("⚠️ MediaSource not open, queueing chunk");
            ttsQueueRef.current.push(buffer);
            return;
          }

          if (!sourceBuffer.updating) {
            try {
              sourceBuffer.appendBuffer(buffer);
            } catch (err) {
              console.error("❌ Error appending buffer:", err);
              setAudioError(err.message);
            }
          } else {
            ttsQueueRef.current.push(buffer);
          }
        });

        return;
      }

      // 📝 MENSAJES JSON (STT)
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === "partial") {
          setPartial(msg.data.text || "");
        }

        if (msg.type === "final") {
          setFinalText(prev => prev + " " + msg.data.text);
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

      } catch (err) {
        console.error("❌ Error parsing JSON:", err);
      }

    };

    return () => {
      wsRef.current.close();
      
      // Limpiar audio y MediaSource
      if (audioElementRef.current) {
        audioElementRef.current.pause();
        audioElementRef.current.src = "";
        audioElementRef.current = null;
      }
      
      sourceBufferRef.current = null;
      
      if (mediaSourceRef.current && mediaSourceRef.current.readyState === "open") {
        try {
          mediaSourceRef.current.endOfStream();
        } catch (err) {
          console.warn("Error ending stream:", err);
        }
      }
      mediaSourceRef.current = null;
      
      ttsQueueRef.current = [];
    };
  }, []);

  const startRecording = async () => {
    try {
      silenceStartRef.current = null;
      hasCommittedRef.current = false;
      setAudioError(null);

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Crear nuevo AudioContext cada vez
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(1024, 1, 1);
      processor.onaudioprocess = (e) => {
        const float32Data = e.inputBuffer.getChannelData(0);
        const pcm16 = floatTo16BitPCM(float32Data);

        if (wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(pcm16);
        }

        // 🔇 Detectar silencio (RMS)
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
    } catch (err) {
      console.error("Error al acceder al micrófono:", err);
      setAudioError(err.message);
    }
  };

  const stopRecording = () => {
    // Desconectar processor y source
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    // Detener MediaStream
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Cerrar AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Avisar al servidor
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: "stop" }));
    }
  };

  return (
    <div className="realtime-stt-container">
      <button onClick={startRecording}>🎙️ Start</button>
      <button onClick={stopRecording}>⏹️ Stop</button>

      <p>
        <strong>Texto:</strong> {finalText}{" "}
        <span>{partial}</span>
      </p>

      {thinking && (
        <p style={{ color: "#888", fontStyle: "italic" }}>
          🤔 Pensando…
        </p>
      )}

      {agentText && (
        <p>
          <strong>🤖 Agente:</strong> {agentText}
        </p>
      )}

      {audioError && (
        <div style={{
          padding: "10px",
          backgroundColor: "#fee",
          border: "1px solid #f00",
          borderRadius: "4px",
          marginBottom: "10px"
        }}>
          <strong>⚠️ Audio Error:</strong> {audioError}
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
