export interface NormalizedLead {
  phone: string;
  name: string;
  cpf: string;
}

export class QueueEngine {
  private queue: NormalizedLead[] = [];
  private head = 0;
  private seenPhones = new Set<string>();
  private seenCpfs = new Set<string>();
  private _duplicates = 0;
  private _invalidFormat = 0;
  private _total = 0;

  get duplicates(): number { return this._duplicates; }
  get invalidFormat(): number { return this._invalidFormat; }
  get size(): number { return this.queue.length - this.head; }
  get totalEnqueued(): number { return this._total; }
  get validCount(): number { return this.queue.length; }

  isEmpty(): boolean {
    return this.head >= this.queue.length;
  }

  enqueue(phone: string, name: string, cpf: string): boolean {
    const normalized = this.normalizePhone(phone);
    if (!normalized) {
      this._invalidFormat++;
      return false;
    }

    if (this.seenPhones.has(normalized)) {
      this._duplicates++;
      return false;
    }

    const normalizedCpf = this.normalizeCPF(cpf);
    if (normalizedCpf && this.seenCpfs.has(normalizedCpf)) {
      this._duplicates++;
      return false;
    }

    this.seenPhones.add(normalized);
    if (normalizedCpf) {
      this.seenCpfs.add(normalizedCpf);
    }

    this._total++;
    this.queue.push({
      phone: normalized,
      name: this.normalizeName(name),
      cpf: normalizedCpf,
    });
    return true;
  }

  dequeue(batchSize: number): NormalizedLead[] {
    const end = Math.min(this.head + batchSize, this.queue.length);
    const batch = this.queue.slice(this.head, end);
    this.head = end;

    if (this.head > 5000 && this.head > this.queue.length * 0.5) {
      this.queue = this.queue.slice(this.head);
      this.head = 0;
    }

    return batch;
  }

  private normalizePhone(raw: string): string | null {
    let digits = raw.replace(/\D/g, "");

    if (digits.length === 0) return null;

    if (digits.startsWith("0") && !digits.startsWith("00") && digits.length >= 11 && digits.length <= 13) {
      digits = digits.substring(1);
    }

    let phone = digits;

    if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
      phone = digits;
    } else if (digits.length === 10 || digits.length === 11) {
      phone = "55" + digits;
    } else if (digits.length === 12) {
      if (!digits.startsWith("55")) {
        const possibleDdd = parseInt(digits.substring(0, 2), 10);
        if (possibleDdd >= 11 && possibleDdd <= 99) {
          phone = "55" + digits;
        } else {
          return null;
        }
      } else {
        phone = digits;
      }
    } else if (digits.length === 13) {
      if (!digits.startsWith("55")) {
        return null;
      }
      phone = digits;
    } else {
      return null;
    }

    if (phone.length < 12 || phone.length > 14) {
      return null;
    }

    const ddd = phone.substring(2, 4);
    const dddNum = parseInt(ddd, 10);
    if (dddNum < 11 || dddNum > 99) {
      return null;
    }

    return phone;
  }

  private normalizeName(raw: string): string {
    let name = raw
      .replace(/[\u200B\u200C\u200D\uFEFF\u00A0]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toUpperCase();

    name = name.replace(/[^\w\sÀ-ÿ\-'.]/g, "");
    name = name.replace(/\s+/g, " ").trim();
    return name;
  }

  private normalizeCPF(raw: string): string {
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 11) return "";
    if (/^(\d)\1{10}$/.test(digits)) return "";
    return digits;
  }

  release(): void {
    this.queue = [];
    this.head = 0;
    this.seenPhones.clear();
    this.seenCpfs.clear();
  }
}
