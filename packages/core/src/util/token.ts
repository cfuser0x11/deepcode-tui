export * as Token from "./token.js"


export const estimate = (input: string) => {
  if (!input) return 0
  if (/[\u0400-\u04FF]/.test(input)) {
    return Math.max(1, Math.ceil(input.length / 1.7))
  }
  return Math.max(0, Math.round(input.length / 4))
}
