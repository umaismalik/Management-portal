"use client";

let transcriberPromise;
let transcriptionQueue = Promise.resolve();
let activeJob = null;
const transcriptionJobs = new WeakMap();
const summaryStopWords = new Set("about after again against also among another any are because been before being between both but can could did does doing down during each few for from further had has have having here how into its itself just more most other our out over same should some such than that the their them then there these they this those through too under until very was were what when where which while who why will with would your".split(" "));

const progressText = (event) => {
  if (event.status === "progress" && event.total) {
    const percent = Math.round((event.loaded / event.total) * 100);
    return `Downloading speech model: ${percent}%`;
  }
  if (event.status === "done") return "Speech model ready";
  if (event.status === "initiate") return "Preparing speech model…";
  return "";
};

async function createTranscriber(job) {
  const { pipeline } = await import(/* webpackIgnore: true */ "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2/+esm");
  const options = {
    dtype: "q4",
    progress_callback: (event) => {
      const message = progressText(event);
      if (message)       activeJob?.onProgress(message);
    },
  };
  if (navigator.gpu) {
    try {
      job.onProgress("Starting faster Whisper Base on GPU…");
      return await pipeline("automatic-speech-recognition", "onnx-community/whisper-base", { ...options, device: "webgpu" });
    } catch {
      job.onProgress("Whisper Base GPU is unavailable; loading the faster model on CPU…");
    }
  }
  return pipeline("automatic-speech-recognition", "onnx-community/whisper-base", { ...options, device: "wasm" });
}

async function decodeMono16k(blob) {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  const OfflineAudioContextClass = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioContextClass || !OfflineAudioContextClass) throw new Error("Audio decoding is not supported by this browser.");
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await blob.arrayBuffer());
    const outputLength = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineAudioContextClass(1, outputLength, 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    const audio = resampled.getChannelData(0);
    let energy = 0;
    for (let index = 0; index < audio.length; index += 1) energy += audio[index] * audio[index];
    if (!audio.length || Math.sqrt(energy / audio.length) < 0.0005) {
      throw new Error("The recording is almost silent. Check the selected microphone and make sure it can hear the speakers before recording again.");
    }
    return audio;
  } finally {
    await context.close();
  }
}

export async function transcribeLocally(blob, onProgress, language = "auto") {
  const existing = transcriptionJobs.get(blob);
  if (existing) {
    existing.onProgress = onProgress;
    return existing.promise;
  }
  const job = { onProgress, promise: null };
  job.promise = transcriptionQueue.then(async () => {
    activeJob = job;
    try {
      job.onProgress("Preparing audio…");
      const audio = await decodeMono16k(blob);
      if (!transcriberPromise) transcriberPromise = createTranscriber(job);
      try {
        const transcriber = await transcriberPromise;
        job.onProgress("Translating speech and preparing English key points…");
        return await runTranscription(transcriber, audio, language);
      } catch (error) {
        transcriberPromise = null;
        if (!String(error?.message || error).toLowerCase().includes("session already started")) throw error;
        job.onProgress("Recovering the speech model and retrying…");
        transcriberPromise = createTranscriber(job);
        return await runTranscription(await transcriberPromise, audio, language);
      }
    } finally {
      activeJob = null;
    }
  }).catch((error) => {
    transcriptionJobs.delete(blob);
    throw error;
  });
  transcriptionQueue = job.promise.then(() => undefined, () => undefined);
  transcriptionJobs.set(blob, job);
  return job.promise;
}

async function runTranscription(transcriber, audio, language) {
  const sampleRate = 16000;
  const windowSize = sampleRate * 15;
  const overlapSize = sampleRate * 2;
  const chunkCount = Math.ceil(audio.length / (windowSize - overlapSize));
  const transcripts = [];
  for (let index = 0, offset = 0; offset < audio.length; index += 1, offset += windowSize - overlapSize) {
    const chunk = audio.subarray(offset, Math.min(offset + windowSize, audio.length));
    const paddedAudio = new Float32Array(chunk.length + 8000);
    paddedAudio.set(chunk, 4000);
    const chunkStatus = chunkCount > 1 ? `Transcribing chunk ${index + 1} of ${chunkCount}` : "Transcribing audio";
    const startedAt = Date.now();
    activeJob?.onProgress(`${chunkStatus}…`);
    const progressTimer = setInterval(() => {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      activeJob?.onProgress(`${chunkStatus}… ${elapsedSeconds}s elapsed`);
    }, 5000);
    let result;
    try {
      result = await transcriber(paddedAudio, {
        chunk_length_s: 15,
        stride_length_s: 2,
        num_beams: 1,
        task: "translate",
        ...(language !== "auto" ? { language } : {}),
      });
    } finally {
      clearInterval(progressTimer);
    }
    const text = String(result.text || "").trim();
    if (text) transcripts.push(text);
  }
  return transcripts.reduce((combined, next) => {
    if (!combined) return next;
    const previousWords = [...combined.matchAll(/\S+/g)];
    const nextWords = [...next.matchAll(/\S+/g)];
    const wordKey = (word) => word.toLowerCase().replace(/[^a-z0-9]/g, "");
    const maxOverlap = Math.min(40, previousWords.length, nextWords.length);
    let overlap = 0;
    for (let count = maxOverlap; count > 0; count -= 1) {
      const previousTail = previousWords.slice(-count).map((match) => wordKey(match[0]));
      const nextHead = nextWords.slice(0, count).map((match) => wordKey(match[0]));
      if (previousTail.every((word, index) => word && word === nextHead[index])) {
        overlap = count;
        break;
      }
    }
    return overlap ? `${combined} ${next.slice(nextWords[overlap - 1].index + nextWords[overlap - 1][0].length).trim()}`.trim() : `${combined} ${next}`;
  }, "");
}

function rankSentences(sentences) {
  const termsBySentence = sentences.map((sentence) =>
    (sentence.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((word) => !summaryStopWords.has(word))
  );
  const frequencies = new Map();
  termsBySentence.flat().forEach((word) => frequencies.set(word, (frequencies.get(word) || 0) + 1));
  const discussionCues = /\b(decid(?:e|ed|ing)|agree(?:d)?|action|follow.?up|plan(?:ned)?|need(?:s|ed)?|next|deadline|issue|risk|update|goal|owner|responsib(?:le|ility)|priority|block(?:ed|er)?)\b/i;
  return sentences.map((sentence, index) => {
    const terms = termsBySentence[index];
    const termScore = terms.reduce((score, word) => score + Math.log1p(frequencies.get(word)), 0);
    const lengthPenalty = Math.sqrt(Math.max(terms.length, 1));
    const cueBonus = discussionCues.test(sentence) ? 2 : 0;
    const positionBonus = index === 0 ? 0.5 : 0;
    return { sentence, index, score: termScore / lengthPenalty + cueBonus + positionBonus };
  });
}

const sentenceList = (transcript) => (transcript.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [])
  .map((text) => text.trim())
  .filter(Boolean);

const normalizeWords = (text) => text.toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim()
  .split(/\s+/)
  .filter(Boolean);
const TEAM_NAME_ALIASES = {
  sami: ["sami", "sammy", "samy", "samee"],
  irfan: ["irfan", "irfaan", "erfan"],
  zunaira: ["zunaira", "zunairah", "zunera", "zunariya"],
  mashal: ["mashal", "mashaal", "masal"],
  haider: ["haider", "haidar", "hyder"],
  umais: ["umais", "umays", "humais", "omais"],
  adil: ["adil", "adeel", "aadil"],
  mashhood: ["mashhood", "mashud", "mashood"],
};

function attendeeAliases(attendee) {
  const nameParts = normalizeWords(attendee.name);
  const firstName = nameParts[0] || "";
  const extraAliases = TEAM_NAME_ALIASES[firstName] || [];
  return [...new Set([...nameParts, ...normalizeWords(attendee.name), ...extraAliases.flatMap(normalizeWords)].filter((name) => name.length >= 3))];
}

function editDistance(left, right) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (left[i - 1] === right[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[right.length];
}

function soundex(word) {
  if (!word) return "";
  const codes = { b: "1", f: "1", p: "1", v: "1", c: "2", g: "2", j: "2", k: "2", q: "2", s: "2", x: "2", z: "2", d: "3", t: "3", l: "4", m: "5", n: "5", r: "6" };
  let previous = codes[word[0]] || "";
  let code = word[0].toUpperCase();
  for (const character of word.slice(1)) {
    const current = codes[character] || "";
    if (current && current !== previous) code += current;
    previous = current;
  }
  return (code + "000").slice(0, 4);
}

function nameTokenScore(word, alias) {
  if (word === alias) return 1;
  if (Math.max(word.length, alias.length) >= 4 && editDistance(word, alias) <= 1) return 0.86;
  if (alias.length >= 4 && soundex(word) === soundex(alias)) return 0.72;
  return 0;
}

function attendeeNameMatch(sentence, attendee, cueIndex) {
  const sentenceWords = normalizeWords(sentence);
  const aliases = attendeeAliases(attendee);
  let bestScore = 0;
  for (const alias of aliases) {
    sentenceWords.forEach((word, index) => {
      const distanceFromCue = Math.abs(index - cueIndex);
      if (distanceFromCue > 6) return;
      const score = nameTokenScore(word, alias);
      if (score) bestScore = Math.max(bestScore, score - distanceFromCue * 0.01);
    });
  }
  return bestScore;
}

function resolveTurnAttendee(sentence, attendees, cue) {
  const cueIndex = normalizeWords(sentence.slice(0, cue.index)).length;
  const candidates = attendees
    .map((attendee) => ({ attendee, score: attendeeNameMatch(sentence, attendee, cueIndex) }))
    .filter((candidate) => candidate.score >= 0.7)
    .sort((a, b) => b.score - a.score);
  if (!candidates.length || (candidates.length > 1 && candidates[0].score - candidates[1].score < 0.2)) return null;
  return candidates[0].attendee;
}

export function correctTurnNames(transcript, attendees) {
  if (!attendees.length) return transcript;
  const turnCue = /\b(your turn|it's your turn|it is your turn|you(?:'re| are) next|next(?: up)?|speak next|go next|share next|please (?:go|start|share|speak)|share your update|give your update)\b/i;
  return transcript.replace(/[^.!?]+[.!?]+|[^.!?]+$/g, (sentence) => {
    const cue = turnCue.exec(sentence);
    if (!cue) return sentence;
    const attendee = resolveTurnAttendee(sentence, attendees, cue);
    if (!attendee) return sentence;
    const cueIndex = normalizeWords(sentence.slice(0, cue.index)).length;
    const spokenName = attendee.name.split(/\s+/)[0];
    const aliases = attendeeAliases(attendee);
    const tokens = [...sentence.matchAll(/[A-Za-z][A-Za-z'-]*/g)];
    const closestToken = tokens.reduce((best, token) => {
      const wordIndex = normalizeWords(sentence.slice(0, token.index)).length;
      const score = Math.max(...aliases.map((alias) => nameTokenScore(token[0].toLowerCase(), alias)));
      const weightedScore = score - Math.abs(wordIndex - cueIndex) * 0.01;
      return weightedScore > best.score ? { token, score: weightedScore } : best;
    }, { token: null, score: 0 });
    if (!closestToken.token || closestToken.score < 0.65) return sentence;
    const token = closestToken.token;
    return sentence.slice(0, token.index) + spokenName + sentence.slice(token.index + token[0].length);
  });
}

export function generateEnglishKeyPoints(transcript) {
  const sentences = sentenceList(transcript);
  if (!sentences.length) return "";
  const points = rankSentences(sentences)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .sort((a, b) => a.index - b.index)
    .map(({ sentence }) => `- ${sentence}`);
  return `Meeting key points (English)\n${points.join("\n")}`;
}

export function generateMeetingParticipantCards(transcript, attendees) {
  const sentences = sentenceList(transcript);
  const turnCue = /\b(your turn|it's your turn|it is your turn|you(?:'re| are) next|next(?: up)?|speak next|go next|share next|please (?:go|start|share|speak)|share your update|give your update)\b/i;
  const taskCue = /\b(need to|needs to|should|must|will|action item|follow.?up|by (?:monday|tuesday|wednesday|thursday|friday|next week|tomorrow))\b/i;
  const sections = new Map();
  let current = null;
  sentences.forEach((sentence) => {
    const cue = turnCue.exec(sentence);
    if (cue) {
      current = resolveTurnAttendee(sentence, attendees, cue);
      return;
    }
    if (!current) return;
    if (!sections.has(current.id)) sections.set(current.id, { attendee: current, sentences: [] });
    sections.get(current.id).sentences.push(sentence);
  });
  return [...sections.values()].map(({ attendee, sentences: memberSentences }) => {
    const ranked = rankSentences(memberSentences);
    const points = ranked
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .sort((a, b) => a.index - b.index)
      .map(({ sentence }) => sentence);
    return {
      memberId: attendee.id,
      name: attendee.name,
      points,
      tasks: memberSentences.filter((sentence) => taskCue.test(sentence)).slice(0, 10),
    };
  }).filter((card) => card.points.length || card.tasks.length);
}
