export class TextHumanizerService {
  private readonly abbreviations: Record<string, string> = {
    'sr.': 'Senhor',
    'sra.': 'Senhora',
    'dr.': 'Doutor',
    'dra.': 'Doutora',
    'prof.': 'Professor',
    'profa.': 'Professora',
    'tel.': 'Telefone',
    'av.': 'Avenida',
    'r.': 'Rua',
    'no.': 'número',
    'nº': 'número',
    'etc.': 'etcétera',
    'obs.': 'Observação',
    'p.': 'página',
    'pág.': 'página',
    'kg': 'quilogramas',
    'km': 'quilômetros',
    'ml': 'mililitros',
    'mg': 'miligramas',
    'hrs': 'horas',
    'hr': 'hora',
    'min': 'minuto',
    'seg': 'segundo',
    'vs.': 'versus',
    'p.ex.': 'por exemplo',
    'ex.': 'por exemplo',
  };

  humanize(text: string): string {
    if (!text || !text.trim()) return text;

    let result = text;

    result = this.expandAbbreviations(result);
    result = this.normalizePunctuation(result);
    result = this.insertNaturalPauses(result);
    result = this.breakLongSentences(result);

    return result.trim();
  }

  private expandAbbreviations(text: string): string {
    let result = text;
    for (const [abbr, expansion] of Object.entries(this.abbreviations)) {
      const escaped = abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}`, 'gi');
      result = result.replace(regex, expansion);
    }
    return result;
  }

  private normalizePunctuation(text: string): string {
    let result = text;

    result = result.replace(/\.{2,}/g, '...');
    result = result.replace(/!{2,}/g, '!');
    result = result.replace(/\?{2,}/g, '?');

    result = result.replace(/([.,;:!?])([^\s])/g, '$1 $2');

    result = result.replace(/\s{2,}/g, ' ');

    return result;
  }

  private insertNaturalPauses(text: string): string {
    let result = text;

    result = result.replace(/([.!?])\s+(?=[A-ZÁÉÍÓÚÂÊÎÔÛÃÕÀÈÌÒÙÇ])/g, '$1 ');

    return result;
  }

  private breakLongSentences(text: string): string {
    const sentences = text.split(/(?<=[.!?])\s+/);
    const processed: string[] = [];

    for (const sentence of sentences) {
      const words = sentence.split(/\s+/);
      if (words.length > 30) {
        const midpoint = Math.floor(words.length / 2);
        const conjunctions = ['e', 'mas', 'porém', 'contudo', 'entretanto', 'pois', 'porque', 'que', 'quando', 'se'];

        let breakPoint = midpoint;
        for (let i = midpoint - 5; i < midpoint + 5; i++) {
          if (i > 0 && i < words.length && conjunctions.includes(words[i].toLowerCase())) {
            breakPoint = i;
            break;
          }
        }

        const part1 = words.slice(0, breakPoint).join(' ');
        const part2 = words.slice(breakPoint).join(' ');
        processed.push(part1, part2);
      } else {
        processed.push(sentence);
      }
    }

    return processed.join(' ');
  }
}

export const textHumanizerService = new TextHumanizerService();
