import re
from typing import List, Dict, Tuple

def validate_cpf(cpf: str) -> bool:
    """Validate Brazilian CPF format and checksum"""
    # Remove non-numeric characters
    cpf = re.sub(r'\D', '', cpf)
    
    # Check if it has 11 digits
    if len(cpf) != 11:
        return False
    
    # Check if all digits are the same
    if cpf == cpf[0] * 11:
        return False
    
    # Calculate first verification digit
    sum1 = 0
    for i in range(9):
        sum1 += int(cpf[i]) * (10 - i)
    
    remainder1 = sum1 % 11
    digit1 = 0 if remainder1 < 2 else 11 - remainder1
    
    if int(cpf[9]) != digit1:
        return False
    
    # Calculate second verification digit
    sum2 = 0
    for i in range(10):
        sum2 += int(cpf[i]) * (11 - i)
    
    remainder2 = sum2 % 11
    digit2 = 0 if remainder2 < 2 else 11 - remainder2
    
    if int(cpf[10]) != digit2:
        return False
    
    return True

def format_phone_number(phone: str) -> str:
    """Format Brazilian phone number for Z-API (with country code 55)"""
    # Remove all non-numeric characters
    phone = re.sub(r'\D', '', phone)
    
    # Remove leading zero from area code if present
    if len(phone) == 11 and phone.startswith('0'):
        phone = phone[1:]
    
    # Ensure we have 11 digits for mobile (DDD + 9 + 8 digits)
    if len(phone) == 10:
        # Add digit 9 for mobile numbers if missing
        if phone[2] in '6789':  # Mobile number indicators
            phone = phone[:2] + '9' + phone[2:]
    
    # Add country code 55 if not present
    if len(phone) == 11 and not phone.startswith('55'):
        phone = '55' + phone
    
    return phone

def parse_leads(leads_text: str) -> Tuple[List[Dict], List[str]]:
    """Parse leads from text format: numero,nome,CPF"""
    leads = []
    errors = []
    
    lines = leads_text.strip().split('\n')
    
    for line_num, line in enumerate(lines, 1):
        line = line.strip()
        if not line:
            continue
        
        parts = [part.strip() for part in line.split(',')]
        
        if len(parts) != 3:
            errors.append(f"Linha {line_num}: Formato inválido. Use: numero,nome,CPF")
            continue
        
        numero, nome, cpf = parts
        
        # Validate phone number
        if not numero:
            errors.append(f"Linha {line_num}: Número de telefone é obrigatório")
            continue
        
        formatted_phone = format_phone_number(numero)
        if len(formatted_phone) < 10:
            errors.append(f"Linha {line_num}: Número de telefone inválido: {numero}")
            continue
        
        # Validate name
        if not nome:
            errors.append(f"Linha {line_num}: Nome é obrigatório")
            continue
        
        # Validate CPF
        if not validate_cpf(cpf):
            errors.append(f"Linha {line_num}: CPF inválido: {cpf}")
            continue
        
        # Format CPF
        cpf_clean = re.sub(r'\D', '', cpf)
        cpf_formatted = f"{cpf_clean[:3]}.{cpf_clean[3:6]}.{cpf_clean[6:9]}-{cpf_clean[9:]}"
        
        leads.append({
            'numero': formatted_phone,
            'nome': nome,
            'cpf': cpf_formatted
        })
    
    return leads, errors
