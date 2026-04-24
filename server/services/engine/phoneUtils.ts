export function formatToE164Strict(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.length < 10 || digits.length > 15) {
    throw new Error('INVALID_PHONE_FORMAT');
  }

  const normalized = digits.startsWith('55') ? digits : `55${digits}`;

  if (normalized.length < 12 || normalized.length > 15) {
    throw new Error('INVALID_PHONE_LENGTH');
  }

  return `+${normalized}`;
}

export function formatPhoneE164(phone: string): string {
  let cleanPhone = phone.replace(/[^\d]/g, '');

  if (cleanPhone.startsWith('0')) {
    cleanPhone = cleanPhone.substring(1);
  }

  if (cleanPhone.length === 10) {
    const ddd = cleanPhone.substring(0, 2);
    const numero = cleanPhone.substring(2);
    if (['6', '7', '8', '9'].includes(numero[0])) {
      cleanPhone = '55' + ddd + '9' + numero;
    } else {
      cleanPhone = '55' + ddd + numero;
    }
  } else if (cleanPhone.length === 11) {
    cleanPhone = '55' + cleanPhone;
  } else if (cleanPhone.length === 12 && cleanPhone.startsWith('55')) {
    const ddd = cleanPhone.substring(2, 4);
    const numero = cleanPhone.substring(4);
    if (['6', '7', '8', '9'].includes(numero[0])) {
      cleanPhone = '55' + ddd + '9' + numero;
    }
  } else if (cleanPhone.length === 13) {
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = '55' + cleanPhone.slice(-11);
    }
  } else if (cleanPhone.length > 13) {
    cleanPhone = cleanPhone.slice(-13);
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = '55' + cleanPhone.slice(-11);
    }
  } else if (cleanPhone.length < 10 && cleanPhone.length >= 8) {
    if (!cleanPhone.startsWith('55')) {
      cleanPhone = '55' + cleanPhone;
    }
  }

  return '+' + cleanPhone;
}
