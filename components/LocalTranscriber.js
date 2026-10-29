"use client";

import { useEffect, useRef } from "react";
import { transcribeLocally } from "../lib/local-transcription";

export default function LocalTranscriber({ audio, language, onProgress, onComplete, onError }) {
  const callbacks = useRef({ onProgress, onComplete, onError });
  callbacks.current = { onProgress, onComplete, onError };

  useEffect(() => {
    let cancelled = false;
    transcribeLocally(audio, (message) => {
      if (!cancelled) callbacks.current.onProgress(message);
    }, language).then((text) => {
      if (cancelled) return;
      if (!text) callbacks.current.onError("No speech was detected. Try a clearer recording.");
      else callbacks.current.onComplete(text);
    }).catch((error) => {
      if (!cancelled) callbacks.current.onError(error.message || "On-device transcription failed. Check your internet connection for the initial model download and try again.");
    });
    return () => { cancelled = true; };
  }, [audio, language]);

  return null;
}
