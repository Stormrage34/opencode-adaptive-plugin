import { get_encoding } from "tiktoken"

const enc = get_encoding("cl100k_base")

self.onmessage = (evt: MessageEvent) => {
  const { id, text } = JSON.parse(evt.data) as { id: string; text: string }
  const tokens = enc.encode(text)
  self.postMessage(JSON.stringify({ id, tokens: tokens.length }))
}

// Cleanup on worker close
self.onclose = () => {
  enc.free()
}

export {} // Ensure this is a module
