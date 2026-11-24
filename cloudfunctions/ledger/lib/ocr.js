function extractMileageCandidates(items) {
  const texts = (items || [])
    .map((item) => String((item && item.text) || '').trim())
    .filter(Boolean)

  const candidates = []
  const seen = new Set()

  texts.forEach((text, index) => {
    const context = [texts[index - 1] || '', text, texts[index + 1] || ''].join(' ')
    const contextual = /(km|odo|总里程|里程|仪表)/i.test(context)
    const matches = text.match(/\d{4,7}(?:\.\d)?/g) || []

    matches.forEach((raw) => {
      const value = Number(raw)
      if (!Number.isFinite(value) || value < 1000 || value > 2000000) return
      if (seen.has(value)) return
      seen.add(value)

      let score = 0
      if (contextual) score += 100
      if (value >= 10000) score += 10
      if (value >= 100000) score += 5

      candidates.push({ value, text, score })
    })
  })

  return candidates
    .sort((a, b) => b.score - a.score || b.value - a.value)
    .slice(0, 6)
    .map((item) => ({ value: Math.round(item.value), text: item.text }))
}

module.exports = { extractMileageCandidates }
