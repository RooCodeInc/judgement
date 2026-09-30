/** Escape control characters in repository-controlled text before terminal output. */
export const terminalText = (text) =>
  String(text).replace(
    /[\x00-\x08\x0b-\x1f\x7f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** A bounded preview of changes, not a claim that the model localized a violation. */
export function changedLines(request) {
  const changes = [];
  let omitted = 0;
  const patches = new Map();
  for (const item of request.evidence) {
    if (item.kind === 'patch' && request.focusPaths.includes(item.path))
      patches.set(item.path, (patches.get(item.path) ?? '') + item.text);
  }
  for (const [path, patch] of patches) {
    let oldLine = null,
      newLine = null;
    for (const text of patch.split('\n')) {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        continue;
      }
      if (
        oldLine === null &&
        newLine === null &&
        (text.startsWith('--- ') ||
          text.startsWith('+++ ') ||
          text.startsWith('diff ') ||
          text.startsWith('index '))
      )
        continue;
      const side =
        text[0] === '+' ? 'after' : text[0] === '-' ? 'before' : null;
      if (side) {
        if (changes.length < 12)
          changes.push({
            path,
            side,
            line: side === 'after' ? newLine : oldLine,
            text: text.slice(1, 241),
            truncated: text.length > 241,
          });
        else omitted++;
      }
      if (text[0] === '+' && newLine !== null) newLine++;
      if (text[0] === '-' && oldLine !== null) oldLine++;
      if (text[0] === ' ') {
        if (oldLine !== null) oldLine++;
        if (newLine !== null) newLine++;
      }
    }
  }
  return { changes, omitted };
}

export function formatProgress(event) {
  return `judgement: ${event.files} files; ${event.rulesFinished}/${event.rulesTotal} rules finished; ${event.judged} packets checked (${event.cached} cached); ${Math.round(event.elapsedMs / 1000)}s`;
}

/** Delayed, rate-limited stderr feedback. No additional inference or deadline changes. */
export function createProgressReporter({
  write = (text) => process.stderr.write(text),
  delayMs = 750,
  intervalMs = 2000,
} = {}) {
  let event, interval, receivedAt;
  const emit = () => {
    if (event)
      write(
        formatProgress({
          ...event,
          elapsedMs: event.elapsedMs + performance.now() - receivedAt,
        }) + '\n',
      );
  };
  const timer = setTimeout(() => {
    emit();
    interval = setInterval(emit, intervalMs);
    interval.unref?.();
  }, delayMs);
  timer.unref?.();
  return {
    update: (value) => {
      event = value;
      receivedAt = performance.now();
    },
    stop: () => {
      clearTimeout(timer);
      clearInterval(interval);
    },
  };
}
