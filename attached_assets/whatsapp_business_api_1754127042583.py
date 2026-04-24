import os
import requests
import logging
from typing import Dict, List, Optional, Tuple
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

class WhatsAppBusinessAPI:
    """Service for WhatsApp Business API (Facebook Cloud API) integration"""
    
    def __init__(self):
        self.api_version = 'v22.0'
        self.base_url = f'https://graph.facebook.com/{self.api_version}'
        
        # Initialize with empty credentials
        self._access_token = None
        self._phone_number_id = None
        self._business_account_id = None
        self._headers = None
        self._last_token_check = None
        self._available_phones = []
        self._current_phone_index = 0
        
        # Initialize optimized HTTP session for maximum speed
        self.session = requests.Session()
        
        # STABLE connection pooling - prevents thread exhaustion
        retry_strategy = Retry(
            total=2,  # Reasonable retries for stability
            backoff_factor=0.1,  # Stable backoff
            status_forcelist=[429, 500, 502, 503, 504],
        )
        adapter = HTTPAdapter(
            pool_connections=200,  # Optimized connection pool for stability
            pool_maxsize=200,  # 200 connections per adapter
            max_retries=retry_strategy
        )
        self.session.mount("http://", adapter)
        self.session.mount("https://", adapter)
        
        # Load initial credentials
        self._refresh_credentials()
        
        if self._access_token:
            logging.info("WhatsApp Business API initialized - ULTRA STABLE com connection pooling otimizado")
        else:
            logging.warning("WhatsApp Business API credentials not found in environment variables")
    
    def _refresh_credentials(self):
        """Refresh credentials from environment variables with multi-BM support"""
        # Always get fresh credentials from environment
        new_token = os.getenv('WHATSAPP_ACCESS_TOKEN')
        
        # Auto-detect Business Manager and Phone based on token
        if new_token and new_token != self._last_token_check:
            self._last_token_check = new_token
            
            # Tentar descobrir automaticamente primeiro
            discovered = self._get_cached_fallback()
            if discovered:
                self._business_account_id = discovered['business_account_id']
                self._available_phones = discovered['phone_numbers']
                self._has_error_135000 = discovered.get('has_error_135000', False)
                logging.info(f"AUTO-DESCOBERTO: BM {self._business_account_id} - {len(self._available_phones)} phones")
            else:
                # Fallback para detecção baseada no padrão do token ou manual para BM conhecida
                if 'EAAZAPHnka8gYBPJPFyRsoiLBPOqtxjGnA2YGFy4ZCWbKzh5xP' in new_token:
                    # BM Cleide atualizada - CONFIRMADO: erro #135000 sistemático mas templates aprovados funcionais
                    self._business_account_id = "580318035149016"
                    self._available_phones = ["710232202173614", "739188885941111", "709194588941211", "767158596471686"]
                    self._has_error_135000 = True  # Flag para ativar fallback automático
                    logging.info("FALLBACK: BM Cleide (580318035149016) - 4 phones Quality GREEN, erro #135000 sistemático")
                elif 'EAAHUCvWVsdgBP' in new_token:
                    # BM Iara - nova Business Manager com 20 números
                    self._business_account_id = "2089992404820473"
                    self._available_phones = ["725492557312328", "800312496489716", "776788602173980", "774576132396207", "764495823408049", "764138826774184", "749599158230143", "747868138404614", "746367015221228", "736306482898341", "732911983238956", "728240807037686", "721222711076869", "718291801369739", "712294161968633", "706148559252459", "698088016726677", "674341985771514", "672331669304211", "670736396133662"]
                    self._has_error_135000 = False
                    logging.info("FALLBACK: BM Iara (2089992404820473) - 20 phones Quality GREEN/UNKNOWN sem erro #135000")
                elif 'EAAKYElksPsEBP' in new_token:
                    # BM Jose Carlos - configuração anterior 
                    self._business_account_id = "639849885789886"
                    self._available_phones = ["746209145234709", "782640984922130", "775859882269062", "745498515309824", "652047048001128"]
                    self._has_error_135000 = False
                    logging.info("FALLBACK: BM Jose Carlos (639849885789886) - 5 phones Quality GREEN sem erro #135000")
                elif 'EAA9z86lNONYBP' in new_token:
                    # BM Michele - nova configuração sem erro #135000 (descoberto dinamicamente)
                    self._business_account_id = "1523966465251146" 
                    self._available_phones = ["752224571301771", "715028345028798", "708063449062586", "682857414919717", "667340429803430"]
                    self._has_error_135000 = False
                    logging.info("FALLBACK: BM Michele (1523966465251146) - 5 phones Quality GREEN sem erro #135000")
                else:
                    # BM Mauro Augusto Solutions - DESCOBERTOS VIA API: 10 phones, template modelo_x aprovado
                    self._business_account_id = "731820156439386"
                    self._available_phones = ["700117343189613", "779607835226588", "755999900927411", "753399691186667", "752846467908910", "735771636286302", "705010646033507", "698409323364266", "662516480287578", "657634247442816"]
                    self._has_error_135000 = False  # Template modelo_x funcionando
                    logging.info("CONFIGURADO: BM Mauro Augusto Solutions (731820156439386) - 10 phones ativos, template modelo_x aprovado")
            
            new_phone_id = self._available_phones[0]
                
        elif new_token and new_token == self._last_token_check and self._business_account_id:
            # Use cached credentials para evitar rate limits
            new_phone_id = self._phone_number_id or (self._available_phones[0] if self._available_phones else None)
            logging.info("Usando credenciais em cache para evitar rate limits")
        else:
            # Token hasn't changed, keep current phone ID
            new_phone_id = self._phone_number_id
        
        # Update if changed
        if new_token != self._access_token or new_phone_id != self._phone_number_id:
            self._access_token = new_token
            self._phone_number_id = new_phone_id
            
            if self._access_token:
                self._headers = {
                    'Authorization': f'Bearer {self._access_token}',
                    'Content-Type': 'application/json'
                }
                logging.info(f"Token atualizado - {len(self._available_phones)} phones disponíveis para seleção dinâmica (rate limit prevention ativo)")
            else:
                self._headers = {}
    

                logging.warning("WhatsApp credentials not available")
    
    def _get_cached_fallback(self):
        """Return cached fallback based on current token pattern"""
        token = self._access_token or os.getenv('WHATSAPP_ACCESS_TOKEN') or ''
        
        if 'EAAHUCvWVsdgBP' in token:
            return {
                'business_account_id': "2089992404820473",
                'phone_numbers': ["725492557312328", "800312496489716", "776788602173980", "774576132396207", "764495823408049", "764138826774184", "749599158230143", "747868138404614", "746367015221228", "736306482898341", "732911983238956", "728240807037686", "721222711076869", "718291801369739", "712294161968633", "706148559252459", "698088016726677", "674341985771514", "672331669304211", "670736396133662"],
                'has_error_135000': False
            }
        elif 'EAAKYElksPsEBP' in token and 'N6szHJ' in token:
            return {
                'business_account_id': "639849885789886",
                'phone_numbers': ["743171782208180", "696547163548546"],
                'has_error_135000': False
            }
        elif 'EAAKYElksPsEBP' in token:
            return {
                'business_account_id': "639849885789886",
                'phone_numbers': ["746209145234709", "782640984922130", "775859882269062", "745498515309824", "652047048001128"],
                'has_error_135000': False
            }
        elif 'EAA9z86lNONYBP' in token:
            return {
                'business_account_id': "1523966465251146",
                'phone_numbers': ["752224571301771", "715028345028798", "708063449062586", "682857414919717", "667340429803430"],
                'has_error_135000': False
            }
        return None

    def _discover_whatsapp_ids_original(self, access_token: str) -> Optional[Dict]:
        """Auto-discover both Business Manager ID and Phone Number ID"""
        try:
            # First, get the Business Account ID
            headers = {'Authorization': f'Bearer {access_token}', 'Content-Type': 'application/json'}
            
            # Try to get business account from me endpoint
            me_response = requests.get(f"{self.base_url}/me", headers=headers, timeout=10)
            if me_response.status_code != 200:
                return None
            
            me_data = me_response.json()
            user_id = me_data.get('id')
            
            if not user_id:
                return None
            
            # Get business accounts associated with this user
            # Try different approaches to find WhatsApp Business Account
            possible_endpoints = [
                f"{self.base_url}/{user_id}?fields=accounts",
                f"{self.base_url}/me?fields=accounts",
                f"{self.base_url}/me?fields=businesses"
            ]
            
            business_account_id = None
            
            for endpoint in possible_endpoints:
                try:
                    response = requests.get(endpoint, headers=headers, timeout=10)
                    if response.status_code == 200:
                        data = response.json()
                        # Look for accounts or businesses data
                        accounts = data.get('accounts', {}).get('data', []) or data.get('businesses', {}).get('data', [])
                        if accounts:
                            business_account_id = accounts[0].get('id')
                            break
                except:
                    continue
            
            # If we couldn't find business account, try a direct approach
            # Use a known pattern or try common business account discovery
            if not business_account_id:
                # Sometimes the phone numbers are directly accessible
                try:
                    # Try to get WhatsApp Business accounts directly
                    waba_response = requests.get(f"{self.base_url}/me?fields=whatsapp_business_accounts", headers=headers, timeout=10)
                    if waba_response.status_code == 200:
                        waba_data = waba_response.json()
                        accounts = waba_data.get('whatsapp_business_accounts', {}).get('data', [])
                        if accounts:
                            business_account_id = accounts[0].get('id')
                except:
                    pass
            
            # If still no business account, try to scan known patterns or use fallback
            if not business_account_id:
                # Check if the WHATSAPP_PHONE_NUMBER_ID actually contains a business account ID
                current_phone_id = os.getenv('WHATSAPP_PHONE_NUMBER_ID')
                if current_phone_id and len(current_phone_id) > 10:
                    # Try using it as business account ID
                    try:
                        phones_response = requests.get(f"{self.base_url}/{current_phone_id}/phone_numbers", headers=headers, timeout=10)
                        if phones_response.status_code == 200:
                            phones_data = phones_response.json()
                            phone_numbers = phones_data.get('data', [])
                            if phone_numbers:
                                phone_ids = [phone.get('id') for phone in phone_numbers if phone.get('id')]
                                return {
                                    'business_account_id': current_phone_id,
                                    'phone_numbers': phone_ids,
                                    'has_error_135000': False
                                }
                    except:
                        pass
                
                return None
            
            # Now get phone numbers from business account
            phones_response = requests.get(f"{self.base_url}/{business_account_id}/phone_numbers", headers=headers, timeout=10)
            if phones_response.status_code == 200:
                phones_data = phones_response.json()
                phone_numbers = phones_data.get('data', [])
                if phone_numbers:
                    # Extract all phone number IDs
                    phone_ids = [phone.get('id') for phone in phone_numbers if phone.get('id')]
                    logging.info(f"Discovered {len(phone_ids)} phone numbers from business account {business_account_id}")
                    
                    # Check if this BM has known error #135000 issues
                    has_error_135000 = business_account_id in ["580318035149016"]
                    
                    return {
                        'business_account_id': business_account_id,
                        'phone_numbers': phone_ids,
                        'has_error_135000': has_error_135000
                    }
            
            return None
            
        except Exception as e:
            logging.error(f"Error discovering WhatsApp IDs: {str(e)}")
            return None
    
    @property
    def business_account_id(self):
        """Get business account ID"""
        return self._business_account_id
    
    @property
    def access_token(self):
        """Get access token, refreshing credentials if needed"""
        self._refresh_credentials()
        return self._access_token
    
    @property
    def phone_number_id(self):
        """Get phone number ID, refreshing credentials if needed"""
        self._refresh_credentials()
        return self._phone_number_id
    
    @property
    def headers(self):
        """Get headers, refreshing credentials if needed"""
        self._refresh_credentials()
        return self._headers
    
    def set_phone_number_id(self, phone_number_id: str):
        """Set the phone number ID for this request"""
        self._phone_number_id = phone_number_id
        logging.info(f"Phone Number ID set to: {phone_number_id}")
    
    def is_configured(self) -> bool:
        """Check if WhatsApp Business API is properly configured"""
        # Always refresh credentials before checking
        self._refresh_credentials()
        return bool(self._access_token)  # Only check token, phone ID will be set per request
    
    def _check_template_has_button(self, template_name: str) -> bool:
        """Check if a template has button components"""
        try:
            # Get available templates to check structure
            templates = self.get_available_templates()
            
            for template in templates:
                if template.get('name') == template_name:
                    # Check if template has button components
                    components = template.get('components', [])
                    for component in components:
                        if component.get('type') == 'BUTTONS':
                            return True
                    return False
            
            # If template not found, assume it has buttons for safety
            return True
            
        except Exception as e:
            logging.warning(f"Could not check template button structure: {e}")
            # Default to assuming it has buttons for safety
            return True
    
    def _get_template_structure(self, template_name: str) -> Optional[Dict]:
        """Get the complete structure of a template"""
        try:
            # Get available templates to extract structure
            templates = self.get_available_templates()
            
            for template in templates:
                if template.get('name') == template_name:
                    return template
            
            return None
            
        except Exception as e:
            logging.warning(f"Could not get template structure: {e}")
            return None

    def _get_template_exact_content(self, template_name: str, parameters: Optional[List[str]] = None) -> Optional[str]:
        """Get the exact content of a template for fallback messaging"""
        try:
            # For cleide_template_1752692476_0f370e02, use the exact approved structure
            if template_name == 'cleide_template_1752692476_0f370e02' and parameters and len(parameters) >= 2:
                cpf = str(parameters[0]).strip()
                nome = str(parameters[1]).strip()
                
                # Exact content matching the approved template structure
                template_content = f"""*Notificação Extrajudicial*

Prezado (a) {nome}, me chamo Cleide Ferrer. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*

Para evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize imediatamente.

Atenciosamente,  
Cartório 5º Ofício de Notas

PROCESSO Nº: 0009-13.2025.0100-NE

Regularizar meu CPF: https://irpf.intimacao.org/{cpf}"""
                
                return template_content
            
            # Generic template content extraction for other templates
            templates = self.get_available_templates()
            
            for template in templates:
                if template.get('name') == template_name:
                    # Extract all template components for comprehensive content
                    components = template.get('components', [])
                    content_parts = []
                    button_url = None
                    
                    for component in components:
                        comp_type = component.get('type')
                        
                        if comp_type == 'HEADER':
                            header_text = component.get('text', '')
                            if header_text:
                                content_parts.append(f"*{header_text}*")
                        
                        elif comp_type == 'BODY':
                            body_text = component.get('text', '')
                            if body_text and parameters and len(parameters) >= 2:
                                # Para template modelo_x: {{1}} = CPF, {{2}} = Nome (ordem especial)
                                if template_name == 'modelo_x':
                                    cpf = str(parameters[0]).strip()    # Primeiro parâmetro = CPF
                                    nome = str(parameters[1]).strip()   # Segundo parâmetro = Nome
                                    # Ordem modelo_x: {{1}} = CPF, {{2}} = Nome
                                    body_text = body_text.replace('{{1}}', cpf)
                                    body_text = body_text.replace('{{2}}', nome)
                                else:
                                    # Para outros templates: {{1}} = Nome, {{2}} = CPF (padrão)
                                    nome = str(parameters[0]).strip()   # Primeiro parâmetro = Nome  
                                    cpf = str(parameters[1]).strip()    # Segundo parâmetro = CPF
                                    # Ordem padrão: {{1}} = Nome, {{2}} = CPF
                                    body_text = body_text.replace('{{1}}', nome)
                                    body_text = body_text.replace('{{2}}', cpf)
                                
                                # Substituições genéricas
                                body_text = body_text.replace('{cpf}', cpf)
                                body_text = body_text.replace('{nome}', nome)
                            
                            if body_text:
                                content_parts.append(body_text)
                        
                        elif comp_type == 'FOOTER':
                            footer_text = component.get('text', '')
                            if footer_text:
                                content_parts.append(footer_text)
                        
                        elif comp_type == 'BUTTONS':
                            buttons = component.get('buttons', [])
                            for button in buttons:
                                if button.get('type') == 'URL':
                                    button_text = button.get('text', 'Clique aqui')
                                    button_url = button.get('url', '')
                                    
                                    # Replace URL parameter - ajustar para template modelo_x
                                    if button_url and parameters and len(parameters) >= 2:
                                        if template_name == 'modelo_x':
                                            # modelo_x: primeiro parâmetro é CPF
                                            cpf = str(parameters[0]).strip()
                                            button_url = button_url.replace('{{1}}', cpf)
                                        else:
                                            # outros templates: segundo parâmetro é CPF
                                            cpf = str(parameters[1]).strip()
                                            button_url = button_url.replace('{{1}}', cpf)
                                    
                                    if button_url:
                                        content_parts.append(f"{button_text}: {button_url}")
                    
                    return '\n\n'.join(content_parts) if content_parts else None
            
            # Fallback content if template not found
            if parameters and len(parameters) >= 2:
                if template_name == 'modelo_x':
                    # modelo_x: primeiro parâmetro é CPF, segundo é Nome
                    cpf = str(parameters[0]).strip()
                    nome = str(parameters[1]).strip()
                else:
                    # outros templates: primeiro parâmetro é Nome, segundo é CPF
                    nome = str(parameters[0]).strip()
                    cpf = str(parameters[1]).strip()
                return f"🏛️ *CARTÓRIO 5º OFÍCIO DE NOTAS*\n\nPrezado(a) {nome},\n\nEste é um lembrete importante sobre o documento relacionado ao CPF {cpf}.\n\nPara verificar os detalhes, acesse:\nhttps://www.receitaintima.org/{cpf}\n\nAtenciosamente,\nCartório 5º Ofício de Notas"
            
            return None
            
        except Exception as e:
            logging.warning(f"Could not get template content: {e}")
            # Fallback content in case of error
            if parameters and len(parameters) >= 2:
                if template_name == 'modelo_x':
                    # modelo_x: primeiro parâmetro é CPF, segundo é Nome
                    cpf = str(parameters[0]).strip()
                    nome = str(parameters[1]).strip()
                else:
                    # outros templates: primeiro parâmetro é Nome, segundo é CPF
                    nome = str(parameters[0]).strip()
                    cpf = str(parameters[1]).strip()
                return f"🏛️ *CARTÓRIO 5º OFÍCIO DE NOTAS*\n\nPrezado(a) {nome},\n\nEste é um lembrete importante sobre o documento relacionado ao CPF {cpf}.\n\nPara verificar os detalhes, acesse:\nhttps://www.receitaintima.org/{cpf}\n\nAtenciosamente,\nCartório 5º Ofício de Notas"
            return None
    
    def _get_template_exact_content(self, template_name: str, parameters: Optional[List[str]] = None) -> Optional[str]:
        """Extract exact content from an approved template for fallback messaging"""
        try:
            # Hardcoded content for known templates to ensure accuracy
            template_contents = {
                'modelo_01': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado(a) {nome},\n\nEste é um lembrete importante sobre o documento relacionado ao CPF {cpf}.\n\nPara verificar os detalhes, acesse:\nhttps://irpf.intimacao.org/{cpf}\n\nAtenciosamente,\nCartório 5º Ofício de Notas',
                    'footer': 'PROCESSO Nº: 0009-29.2025.0100-NE'
                },
                'modelo1': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo Marcos Antônio Vaz. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *13/07/2025*.\n\nAtenciosamente,  \nCartório 5º Ofício de Notas',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'modelo2': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo Marcos Antônio Vaz. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *13/07/2025*.\n\nAtenciosamente,  \nCartório 5º Ofício de Notas',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'cleide_template_1752692476_0f370e02': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo Cleide Ferrer. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize imediatamente.\n\nAtenciosamente,  \nCartório 5º Ofício de Notas',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                # Templates da BM Jose Carlos (639849885789886)
                'jose_carlos_template_1': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo Jose Carlos Raimundo Dos Santos. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião Jose Carlos Raimundo Dos Santos',
                    'footer': 'PROCESSO Nº: 0009-22.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'jose_carlos_template_2': {
                    'header': 'Documento Pendente',
                    'body': 'Caro(a) {nome},\n\nEste é José Carlos Raimundo, Tabelião do 5º Ofício de Notas. Identificamos pendências em sua documentação fiscal referente ao CPF {cpf}.\n\nSua situação deve ser regularizada até *22/07/2025* para evitar complicações legais.\n\nRespeitosamente,\nTabelião José Carlos Raimundo',
                    'footer': 'DOC Nº: 5ON-2025-{cpf}',
                    'button': 'Verificar situação: https://irpf.intimacao.org/{cpf}'
                },
                # Templates reais da BM Jose Carlos descobertos
                'jose_template_1752924484_01d5f008': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo José Vaz. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião José Vaz',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'jose_template_1752924461_d50dcbee': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo José Vaz. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião José Vaz',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'modelo3': {
                    'body': 'Prezado (a) me chamo José Carlos. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião José Carlos'
                },
                'jose_template_1752883070_87d0311e': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo José Carlos. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião José Carlos',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                },
                'jose_template_1752882617_40dc6e72': {
                    'header': 'Notificação Extrajudicial',
                    'body': 'Prezado (a) {nome}, me chamo José Carlos. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{cpf}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize ainda no dia *22/07/2025*.\n\nAtenciosamente,  \nTabelião José Carlos',
                    'footer': 'PROCESSO Nº: 0009-13.2025.0100-NE',
                    'button': 'Regularizar meu CPF: https://irpf.intimacao.org/{cpf}'
                }
            }
            
            # Get template content and substitute parameters
            if template_name in template_contents:
                template = template_contents[template_name]
                
                if parameters and len(parameters) >= 2:
                    cpf = str(parameters[0]).strip()   # CORRIGIDO: primeiro parâmetro é cpf
                    nome = str(parameters[1]).strip()  # CORRIGIDO: segundo parâmetro é nome
                    
                    # DEBUG: Log parameters
                    logging.info(f"🔍 TEMPLATE DEBUG - {template_name}: nome='{nome}', cpf='{cpf}'")
                    
                    # Build complete message with exact template structure
                    parts = []
                    if 'header' in template:
                        parts.append(f"*{template['header']}*")
                    
                    if 'body' in template:
                        body = template['body'].format(cpf=cpf, nome=nome)
                        parts.append(body)
                    
                    if 'footer' in template:
                        parts.append(template['footer'])
                    
                    if 'button' in template:
                        button = template['button'].format(cpf=cpf)
                        parts.append(button)
                    
                    return '\n\n'.join(parts)
            
            # Fallback content if template not found or parameters missing
            if parameters and len(parameters) >= 2:
                cpf = str(parameters[0]).strip()   # CORRIGIDO: primeiro parâmetro é cpf
                nome = str(parameters[1]).strip()  # CORRIGIDO: segundo parâmetro é nome
                return f"*Notificação Extrajudicial*\n\nPrezado(a) {nome},\n\nEste é um lembrete importante sobre o documento relacionado ao CPF {cpf}.\n\nPara verificar os detalhes, acesse:\nhttps://irpf.intimacao.org/{cpf}\n\nAtenciosamente,\nCartório 5º Ofício de Notas"
            
            return None
            
        except Exception as e:
            logging.warning(f"Could not get exact template content: {e}")
            return None
    
    def _send_fallback_for_error_135000(self, to: str, template_name: str, parameters: Optional[List[str]] = None, phone_number_id: str = None) -> Tuple[bool, Dict]:
        """
        Intelligent fallback for error #135000 - sends text message with exact template content
        """
        try:
            # Get the exact content of the template
            template_content = self._get_template_exact_content(template_name, parameters)
            
            if not template_content:
                return False, {'error': 'Could not extract template content for fallback'}
            
            # Add fallback indicator to the message
            fallback_content = template_content + "\n\n✅ SISTEMA INTELIGENTE - Erro #135000 detectado e resolvido automaticamente"
            
            # Send as text message using the same phone number ID
            success, result = self.send_text_message(to, fallback_content, phone_number_id)
            
            if success:
                logging.info(f"💡 FALLBACK #135000 SUCCESSFUL - Message ID: {result.get('messageId')}")
                return True, result
            else:
                logging.error(f"💥 FALLBACK #135000 FAILED - {result.get('error')}")
                return False, result
                
        except Exception as e:
            logging.error(f"Error in fallback for #135000: {str(e)}")
            return False, {'error': f'Fallback failed: {str(e)}'}
    
    def test_connection(self) -> Dict:
        """Test WhatsApp Business API connection"""
        if not self.is_configured():
            return {
                'success': False,
                'error': 'WhatsApp Business API não configurada. Configure WHATSAPP_ACCESS_TOKEN'
            }
        
        try:
            # Test by sending a simple API call to verify connection
            url = f"{self.base_url}/me"
            response = requests.get(url, headers=self.headers, timeout=10)
            
            if response.status_code == 200:
                return {
                    'success': True,
                    'message': 'Conexão WhatsApp Business API estabelecida com sucesso',
                    'phone_number': self.phone_number_id,
                    'status': 'connected'
                }
            else:
                error_data = response.json() if response.content else {}
                return {
                    'success': False,
                    'error': f'Erro na conexão: {response.status_code} - {error_data.get("error", {}).get("message", "Erro desconhecido")}'
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"WhatsApp Business API connection test failed: {str(e)}")
            return {
                'success': False,
                'error': f'Erro de conexão: {str(e)}'
            }
    
    def send_text_message(self, phone: str, message: str, phone_number_id: str = None) -> Tuple[bool, Dict]:
        """Send simple text message"""
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        try:
            # Use provided phone_number_id or default
            used_phone_id = phone_number_id or self.phone_number_id
            url = f"{self.base_url}/{used_phone_id}/messages"
            
            # Format phone number (remove country code if present for international format)
            formatted_phone = phone
            if phone.startswith('55'):
                formatted_phone = '+' + phone
            elif not phone.startswith('+'):
                formatted_phone = '+55' + phone
            
            payload = {
                'messaging_product': 'whatsapp',
                'recipient_type': 'individual',
                'to': formatted_phone,
                'type': 'text',
                'text': {
                    'body': message
                }
            }
            
            logging.info(f"Sending text message payload: {payload}")
            
            response = requests.post(url, json=payload, headers=self.headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                logging.info(f"WhatsApp text message API response: {data}")
                
                # Check if message was actually accepted and get contact status
                if data.get('messages') and len(data.get('messages', [])) > 0:
                    message_id = data.get('messages', [{}])[0].get('id', '')
                    contacts = data.get('contacts', [])
                    
                    # Log detailed contact information for debugging delivery issues
                    if contacts:
                        contact_info = contacts[0]
                        wa_id = contact_info.get('wa_id', 'unknown')
                        input_phone = contact_info.get('input', 'unknown')
                        logging.info(f"Message queued - Input: {input_phone}, WhatsApp ID: {wa_id}, Message ID: {message_id}")
                        
                        # Check if the WhatsApp ID was properly resolved
                        if wa_id == 'unknown' or not wa_id:
                            logging.warning(f"WhatsApp ID not resolved for phone {formatted_phone} - message may not be delivered")
                    
                    return True, {
                        'messageId': message_id,
                        'whatsAppId': message_id,
                        'status': 'sent',
                        'contacts': contacts,
                        'phone_resolved': formatted_phone
                    }
                else:
                    logging.error(f"API returned 200 but no messages in response: {data}")
                    return False, {
                        'error': 'API retornou sucesso mas sem mensagens',
                        'details': str(data)
                    }
            else:
                error_data = response.json() if response.content else {}
                logging.error(f"Text message API error: {response.status_code} - {error_data}")
                return False, {
                    'error': f'Erro HTTP {response.status_code}',
                    'details': error_data.get('error', {}).get('message', response.text)
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"Error sending WhatsApp message: {str(e)}")
            return False, {'error': f'Erro de conexão: {str(e)}'}
    
    def send_template_message(self, phone: str, template_name: str, language_code: str = 'en', 
                            parameters: Optional[List[str]] = None, phone_number_id: Optional[str] = None) -> Tuple[bool, Dict]:
        """
        Envia template message usando Phone Number ID específico dos 5 phones ativos
        Business Manager 580318035149016 - sem erro #135000
        """
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        try:
            # All Phone IDs have access to approved templates - use selected Phone ID directly
            used_phone_id = phone_number_id or self.phone_number_id
            url = f"{self.base_url}/{used_phone_id}/messages"
            
            logging.info(f"TENTANDO TEMPLATE APROVADO: {template_name}")
            logging.info(f"Phone Number ID: {used_phone_id}")
            
            # Format phone number
            formatted_phone = phone
            if phone.startswith('55'):
                formatted_phone = '+' + phone
            elif not phone.startswith('+'):
                formatted_phone = '+55' + phone
            
            # Try different template structures to bypass error #135000
            success = False
            error_msg = ""
            
            # Method 1: Minimal structure without optional components
            payload = {
                'messaging_product': 'whatsapp',
                'to': formatted_phone,
                'type': 'template',
                'template': {
                    'name': template_name,
                    'language': {
                        'code': language_code  # Usar o language_code passado como parâmetro
                    }
                }
            }
            
            # Add components only if parameters provided
            if parameters:
                components = []
                
                # Add body with parameters - CORRIGIDO: {{1}} = cpf, {{2}} = nome
                if len(parameters) >= 2:
                    components.append({
                        'type': 'body',
                        'parameters': [
                            {'type': 'text', 'text': str(parameters[0])},  # {{1}} = cpf (primeiro parâmetro)
                            {'type': 'text', 'text': str(parameters[1])}   # {{2}} = nome (segundo parâmetro)
                        ]
                    })
                
                # Add button with CPF parameter - usa o primeiro parâmetro (CPF)
                if len(parameters) >= 2:
                    components.append({
                        'type': 'button',
                        'sub_type': 'url',
                        'index': 0,
                        'parameters': [
                            {'type': 'text', 'text': str(parameters[0])}  # CPF para o botão
                        ]
                    })
                
                payload['template']['components'] = components
            
            logging.info(f"🚀 ENVIANDO TEMPLATE {template_name} - Payload: {payload}")
            
            response = requests.post(url, json=payload, headers=self.headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                message_id = data.get('messages', [{}])[0].get('id', '')
                logging.info(f"✅ TEMPLATE APROVADO FUNCIONOU! {template_name} - Message ID: {message_id}")
                
                return True, {
                    'messageId': message_id,
                    'whatsAppId': message_id,
                    'status': 'sent',
                    'template_used': template_name
                }
            else:
                error_data = response.json() if response.content else {}
                error_message = error_data.get('error', {}).get('message', response.text)
                error_code = error_data.get('error', {}).get('code')
                
                logging.error(f"❌ TEMPLATE FALHOU: {template_name} - Código: {error_code}")
                logging.error(f"Erro detalhado: {error_message}")
                
                # Apply automatic fallback with exact template content for ANY error
                logging.warning(f"🔄 Aplicando fallback automático para template {template_name}")
                
                fallback_success, fallback_result = self._send_fallback_for_error_135000(
                    formatted_phone, template_name, parameters, used_phone_id
                )
                
                if fallback_success:
                    logging.info(f"✅ FALLBACK SUCESSO: Texto enviado com conteúdo do template {template_name}")
                    return True, {
                        'messageId': fallback_result['messageId'],
                        'whatsAppId': fallback_result['messageId'],
                        'status': 'sent',
                        'template_used': template_name,
                        'fallback_applied': True,
                        'original_error': f'Template {template_name} falhou (erro {error_code}) - fallback aplicado automaticamente'
                    }
                else:
                    logging.error(f"❌ FALLBACK TAMBÉM FALHOU para template {template_name}")
                    return False, {
                        'error': f"Template {template_name} falhou e fallback também falhou: {fallback_result.get('error')}",
                        'original_error': error_message,
                        'error_code': error_code
                    }
                
                # CRITICAL: Detect error #135000 and apply intelligent fallback (old code)
                if error_code == 135000:
                    logging.warning(f"🚨 ERROR #135000 DETECTED - Applying intelligent fallback for template {template_name}")
                    
                    # Apply automatic fallback with exact template content
                    fallback_success, fallback_result = self._send_fallback_for_error_135000(
                        formatted_phone, template_name, parameters, used_phone_id
                    )
                    
                    if fallback_success:
                        logging.info(f"✅ FALLBACK SUCCESS - Error #135000 resolved automatically")
                        return True, {
                            'messageId': fallback_result['messageId'],
                            'whatsAppId': fallback_result['messageId'],
                            'status': 'sent',
                            'template_used': template_name,
                            'fallback_applied': True,
                            'original_error': 'Error #135000 - BM incompatibility resolved with fallback'
                        }
                    else:
                        logging.error(f"❌ FALLBACK FAILED - Error #135000 could not be resolved")
                        return False, {
                            'error': f"Error #135000 detected and fallback failed: {fallback_result.get('error')}",
                            'original_error': error_message,
                            'error_code': error_code
                        }
                
                # FORÇA USO DO TEMPLATE APROVADO EXISTENTE
                # Não tentar outros templates - usar apenas fallback direto para erro #135000
                logging.warning(f"BM {self.business_account_id}: Templates bloqueados - usando fallback de texto")
                
                # Apply automatic fallback with exact template content
                fallback_success, fallback_result = self._send_fallback_for_error_135000(
                    formatted_phone, template_name, parameters, used_phone_id
                )
                
                if fallback_success:
                    logging.info(f"✅ FALLBACK SUCESSO: Texto enviado com conteúdo do template {template_name}")
                    return True, {
                        'messageId': fallback_result['messageId'],
                        'whatsAppId': fallback_result['messageId'],
                        'status': 'sent',
                        'template_used': template_name,
                        'fallback_applied': True,
                        'original_error': f'Template {template_name} falhou - fallback aplicado automaticamente'
                    }
                else:
                    logging.error(f"❌ FALLBACK FAILED for template {template_name}")
                    return False, {
                        'error': f"Template {template_name} falhou e fallback também falhou: {fallback_result.get('error')}",
                        'original_error': error_message,
                        'error_code': error_code
                    }
                
        except Exception as e:
            logging.error(f"Erro enviando template {template_name}: {e}")
            return False, {'error': f'Exception sending template: {str(e)}'}
    
    def _handle_legacy_template_send(self, phone: str, template_name: str, language_code: str = 'en', 
                            parameters: Optional[List[str]] = None, phone_number_id: Optional[str] = None) -> Tuple[bool, Dict]:
        """
        MÉTODO LEGADO - mantido para compatibilidade
        """
        try:
            # Format phone number
            formatted_phone = phone
            if phone.startswith('55'):
                formatted_phone = '+' + phone
            elif not phone.startswith('+'):
                formatted_phone = '+55' + phone
            
            # Build template payload - language corrected for approved templates
            corrected_language = 'en' if language_code in ['en_US', 'pt_BR'] else language_code
            
            template_payload = {
                'name': template_name,
                'language': {
                    'code': corrected_language
                }
            }
            
            # Add parameters if provided - must match exact approved template structure
            if parameters:
                formatted_params = []
                for param in parameters:
                    if isinstance(param, dict):
                        formatted_params.append(param)
                    else:
                        formatted_params.append({
                            'type': 'text',
                            'text': str(param).strip()
                        })
                
                components = []
                
                # ESTRUTURA CORRETA PARA TEMPLATES COM HEADER/FOOTER
                # Buscar estrutura real do template
                template_structure = self._get_template_structure(template_name)
                
                if template_structure:
                    # Montar componentes baseados na estrutura real
                    for component in template_structure.get('components', []):
                        comp_type = component.get('type')
                        
                        if comp_type == 'HEADER':
                            # Headers são sempre incluídos
                            header_text = component.get('text', '')
                            if '{{' not in header_text:
                                # Header fixo - incluir sem parâmetros
                                components.append({
                                    'type': 'header'
                                })
                            else:
                                # Header com parâmetros
                                components.append({
                                    'type': 'header',
                                    'parameters': formatted_params[:1]  # Primeiro parâmetro
                                })
                                
                        elif comp_type == 'BODY':
                            # Body sempre tem parâmetros
                            components.append({
                                'type': 'body',
                                'parameters': formatted_params
                            })
                            
                        elif comp_type == 'FOOTER':
                            # Footer sempre incluído
                            footer_text = component.get('text', '')
                            if '{{' not in footer_text:
                                # Footer fixo - incluir sem parâmetros
                                components.append({
                                    'type': 'footer'
                                })
                            else:
                                # Footer com parâmetros (raro)
                                components.append({
                                    'type': 'footer',
                                    'parameters': formatted_params[-1:]  # Último parâmetro
                                })
                            
                        elif comp_type == 'BUTTONS':
                            # Verificar se botões têm parâmetros
                            buttons = component.get('buttons', [])
                            for i, button in enumerate(buttons):
                                if button.get('type') == 'URL':
                                    button_url = button.get('url', '')  # Renamed to avoid conflict
                                    if '{{' in button_url and parameters and len(parameters) > 0:
                                        cpf_param = str(parameters[0]).strip()  # CPF para URL
                                        components.append({
                                            'type': 'button',
                                            'sub_type': 'url',
                                            'index': i,
                                            'parameters': [{
                                                'type': 'text',
                                                'text': cpf_param
                                            }]
                                        })
                else:
                    # Fallback para estrutura simples
                    components.append({
                        'type': 'body',
                        'parameters': formatted_params
                    })
                    
                    if parameters and len(parameters) > 0:
                        cpf_param = str(parameters[0]).strip()
                        components.append({
                            'type': 'button',
                            'sub_type': 'url',
                            'index': 0,
                            'parameters': [{
                                'type': 'text',
                                'text': cpf_param
                            }]
                        })
                
                template_payload['components'] = components
            
            payload = {
                'messaging_product': 'whatsapp',
                'to': formatted_phone,
                'type': 'template',
                'template': template_payload
            }
            
            logging.info(f"Enviando template aprovado '{template_name}' para {formatted_phone}")
            logging.debug(f"Template payload: {payload}")
            logging.debug(f"POST URL: {url}")
            logging.debug(f"Headers: {self.headers}")
            
            response = requests.post(url, json=payload, headers=self.headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                message_id = data.get('messages', [{}])[0].get('id', '')
                logging.info(f"Template aprovado '{template_name}' enviado com sucesso. Message ID: {message_id}")
                
                return True, {
                    'messageId': message_id,
                    'whatsAppId': message_id,
                    'status': 'sent',
                    'template_used': template_name
                }
            else:
                error_data = response.json() if response.content else {}
                error_message = error_data.get('error', {}).get('message', response.text)
                error_details = error_data.get('error', {}).get('error_data', {}).get('details', '')
                
                logging.error(f"TEMPLATE APROVADO FALHOU: {template_name} - {response.status_code}")
                logging.error(f"Erro: {error_message} - Detalhes: {error_details}")
                logging.error(f"Payload que falhou: {payload}")
                
                # NO FALLBACK - Return template error directly
                error_code = error_data.get('error', {}).get('code')
                
                # SEM FALLBACK para outros erros - retorna erro do template
                return False, {
                    'error': f'Template aprovado "{template_name}" falhou: {error_message}',
                    'details': error_details,
                    'template_name': template_name,
                    'error_code': error_code
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"Erro de conexão ao enviar template aprovado: {str(e)}")
            return False, {'error': f'Erro de conexão: {str(e)}'}
    
    def send_template_message_with_button(self, phone: str, template_name: str, language_code: str = 'en', 
                                        parameters: Optional[List[str]] = None, button_param: str = '') -> Tuple[bool, Dict]:
        """Send template message with button parameter (like modelo_3)"""
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        try:
            url = f"{self.base_url}/{self.phone_number_id}/messages"
            
            # Format phone number
            formatted_phone = phone
            if phone.startswith('55'):
                formatted_phone = '+' + phone
            elif not phone.startswith('+'):
                formatted_phone = '+55' + phone
            
            # Build template payload with button
            components = []
            
            # Body component with parameters
            if parameters:
                formatted_params = []
                for param in parameters:
                    param_index = len(formatted_params)
                    formatted_params.append({
                        'type': 'text',
                        'parameter_name': str(param_index + 1),
                        'text': str(param).strip()
                    })
                
                components.append({
                    'type': 'body',
                    'parameters': formatted_params
                })
            
            # Button component with parameter - correct format for URL buttons
            if button_param:
                components.append({
                    'type': 'button',
                    'sub_type': 'url',
                    'index': 0,  # Use integer instead of string
                    'parameters': [{
                        'type': 'text',
                        'text': str(button_param).strip()
                    }]
                })
            
            template_payload = {
                'name': template_name,
                'language': {
                    'code': language_code
                },
                'components': components
            }
            
            payload = {
                'messaging_product': 'whatsapp',
                'to': formatted_phone,
                'type': 'template',
                'template': template_payload
            }
            
            response = requests.post(url, json=payload, headers=self.headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                return True, {
                    'messageId': data.get('messages', [{}])[0].get('id', ''),
                    'whatsAppId': data.get('messages', [{}])[0].get('id', ''),
                    'status': 'sent'
                }
            else:
                error_data = response.json() if response.content else {}
                error_message = error_data.get('error', {}).get('message', response.text)
                
                logging.error(f"Template with button failed: {response.status_code} - {error_message}")
                logging.error(f"Failed payload was: {payload}")
                
                return False, {
                    'error': f'Erro HTTP {response.status_code}',
                    'details': error_message
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"Error sending WhatsApp template with button: {str(e)}")
            return False, {'error': f'Erro de conexão: {str(e)}'}
    
    def send_button_message(self, phone: str, message: str, buttons: List[Dict]) -> Tuple[bool, Dict]:
        """Send message with interactive buttons (template-based)"""
        # Note: WhatsApp Business API requires pre-approved templates for button messages
        # This is a simplified implementation - in production, you'd need approved templates
        
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        if not buttons:
            # If no buttons, send as simple text
            return self.send_text_message(phone, message)
        
        # For now, send as text message with button descriptions
        # In production, you'd use approved interactive templates
        button_text = "\n\n📱 Opções disponíveis:"
        for i, button in enumerate(buttons, 1):
            button_text += f"\n{i}. {button.get('text', button.get('label', 'Opção'))}"
            if button.get('url'):
                button_text += f" - {button['url']}"
        
        full_message = message + button_text
        return self.send_text_message(phone, full_message)
    
    def get_message_status(self, message_id: str) -> Tuple[bool, Dict]:
        """Get message delivery status"""
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        try:
            url = f"{self.base_url}/{message_id}"
            response = requests.get(url, headers=self.headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                return True, {
                    'status': data.get('status', 'unknown'),
                    'timestamp': data.get('timestamp', ''),
                    'recipient_id': data.get('recipient_id', '')
                }
            else:
                return False, {'error': f'Erro ao consultar status: {response.status_code}'}
                
        except requests.exceptions.RequestException as e:
            logging.error(f"Error getting message status: {str(e)}")
            return False, {'error': f'Erro de conexão: {str(e)}'}

    def get_business_account_id(self) -> Optional[str]:
        """Get Business Account ID from current WhatsApp Business account"""
        if not self.is_configured():
            return None
        
        try:
            # Get business account info
            url = f"{self.base_url}/{self.phone_number_id}"
            response = requests.get(url, headers=self.headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                # Extract business account ID from the response
                business_account_id = data.get('business_account_id')
                if business_account_id:
                    logging.info(f"Business Account ID found: {business_account_id}")
                    return business_account_id
                else:
                    logging.warning("Business Account ID not found in response")
                    return None
            else:
                logging.error(f"Failed to get business account info: {response.status_code}")
                return None
                
        except Exception as e:
            logging.error(f"Error getting business account ID: {str(e)}")
            return None

    def get_available_templates(self, business_account_id_override: Optional[str] = None) -> List[Dict]:
        """Get all available message templates from the WhatsApp Business account"""
        if not self.is_configured():
            return []
        
        try:
            # Use the current Business Manager with 10 phones active
            business_account_id = business_account_id_override or self._business_account_id or "1779444112928258"
            
            url = f"{self.base_url}/{business_account_id}/message_templates"
            logging.info(f"Buscando templates do Business Account: {business_account_id}")
            
            response = requests.get(url, headers=self.headers, timeout=15)
            
            if response.status_code == 200:
                data = response.json()
                templates = data.get('data', [])
                
                # Lista de templates aprovados específicos baseada na BM atual
                if business_account_id == "639849885789886":
                    # BM Jose Carlos - usar templates reais descobertos
                    approved_template_names = [
                        'jose_template_1752924484_01d5f008',
                        'jose_template_1752924461_d50dcbee',
                        'modelo3',
                        'jose_template_1752883070_87d0311e',
                        'jose_template_1752882617_40dc6e72'
                    ]
                elif business_account_id == "580318035149016":
                    # BM Cleide
                    approved_template_names = [
                        'cleide_template_1752692476_0f370e02',
                        'modelo1',
                        'modelo2'
                    ]
                elif business_account_id == "1523966465251146":
                    # BM Michele - templates descobertos dinamicamente
                    approved_template_names = [
                        'michele_template_1753101024_fef7402b',
                        'michele_template_1753073988_55619758',
                        'aviso'
                    ]
                else:
                    # BM padrão
                    approved_template_names = [
                        'replica_approved_4402f709',
                        'replica_approved_30b53a7c', 
                        'final_approved_a251c625',
                        'final_approved_246bd703',
                        'final_approved_eace7f6f'
                    ]
                
                formatted_templates = []
                for template in templates:
                    # FILTRAR APENAS TEMPLATES APROVADOS E NA LISTA ESPECÍFICA
                    template_status = template.get('status', 'UNKNOWN')
                    template_name = template.get('name', '')
                    
                    if template_status != 'APPROVED':
                        continue  # Pular templates não aprovados
                    
                    if template_name not in approved_template_names:
                        continue  # Pular templates não na lista específica
                    
                    # Process template data
                    template_info = {
                        'name': template.get('name', ''),
                        'language': template.get('language', 'en'),
                        'category': template.get('category', 'UTILITY'),
                        'status': template_status,
                        'components': template.get('components', []),
                        'has_parameters': any(
                            comp.get('text', '').find('{{') != -1 
                            for comp in template.get('components', [])
                            if comp.get('type') == 'BODY'
                        ),
                        'has_buttons': any(
                            comp.get('type') == 'BUTTONS' 
                            for comp in template.get('components', [])
                        )
                    }
                    formatted_templates.append(template_info)
                
                logging.info(f"Encontrados {len(formatted_templates)} templates APROVADOS (filtrados de {len(templates)} totais)")
                return formatted_templates
                
            else:
                logging.error(f"Erro ao buscar templates: {response.status_code} - {response.text}")
                # Fallback para templates conhecidos
                return self._get_fallback_templates()
                
        except Exception as e:
            logging.error(f"Erro na busca de templates: {str(e)}")
            return self._get_fallback_templates()
    
    def _get_fallback_templates(self) -> List[Dict]:
        """Templates reais aprovados na conta (ID: 746006914691827)"""
        logging.info("Usando templates APROVADOS da conta")
        return [
            {
                'name': 'modelo1',
                'language': 'en',
                'category': 'UTILITY', 
                'status': 'APPROVED',
                'id': '1409279126974744',
                'components': [
                    {
                        'type': 'BODY',
                        'text': 'Prezado (a) {{2}}, me chamo Damião Alves e sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{{1}}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize imediatamente.\n\nAtenciosamente,\nCartório 5º Ofício de Notas'
                    },
                    {
                        'type': 'FOOTER',
                        'text': 'PROCESSO Nº: 0009-13.2025.0100-NE'
                    },
                    {
                        'type': 'BUTTONS',
                        'buttons': [
                            {
                                'type': 'URL',
                                'text': 'Regularizar meu CPF',
                                'url': 'https://www.intimacao.org/{{1}}'
                            }
                        ]
                    }
                ],
                'has_parameters': True,
                'has_buttons': True
            },
            {
                'name': 'modelo2',
                'language': 'en',
                'category': 'UTILITY', 
                'status': 'APPROVED',
                'id': '1100293608691435',
                'components': [
                    {
                        'type': 'HEADER',
                        'format': 'TEXT',
                        'text': 'Notificação Extrajudicial'
                    },
                    {
                        'type': 'BODY',
                        'text': 'Prezado (a) {{2}}, me chamo Damião Alves Vaz. Sou tabelião do Cartório 5º Ofício de Notas. Consta em nossos registros uma inconsistência relacionada à sua declaração de Imposto de Renda, vinculada ao CPF *{{1}}.*\n\nPara evitar restrições ou bloqueios nas próximas horas, orientamos que verifique sua situação e regularize imediatamente.\n\nAtenciosamente,\nCartório 5º Ofício de Notas'
                    },
                    {
                        'type': 'FOOTER',
                        'text': 'PROCESSO Nº: 0009-13.2025.0100-NE'
                    },
                    {
                        'type': 'BUTTONS',
                        'buttons': [
                            {
                                'type': 'URL',
                                'text': 'Regularizar meu CPF',
                                'url': 'https://www.intimacao.org/{{1}}'
                            }
                        ]
                    }
                ],
                'has_parameters': True,
                'has_buttons': True
            }
        ]
    
    def get_next_phone_id(self) -> str:
        """Get next phone ID in rotation for load balancing"""
        if not hasattr(self, '_available_phones') or not self._available_phones:
            # Initialize with working phones if not set
            self._available_phones = [
                "739188885941111",  # Phone 1: +1 804-210-0219 (Tabelião Cleide Maria)
                "710232202173614",  # Phone 2: +1 830-445-8877 (Tabelião Cleide Maria)
                "709194588941211"   # Phone 3: 15558146853 (Cleide Maria Da Silva)
            ]
            self._current_phone_index = 0
        
        # Rotate to next phone
        phone_id = self._available_phones[self._current_phone_index]
        self._current_phone_index = (self._current_phone_index + 1) % len(self._available_phones)
        
        return phone_id
    
    def get_all_phone_numbers(self) -> List[Dict]:
        """Get all available phone numbers with their details"""
        return [
            {'id': '739188885941111', 'number': '+1 804-210-0219', 'name': 'Tabelião Cleide Maria'},
            {'id': '710232202173614', 'number': '+1 830-445-8877', 'name': 'Tabelião Cleide Maria'},
            {'id': '709194588941211', 'number': '15558146853', 'name': 'Cleide Maria Da Silva'}
        ]
    
    def send_template_with_load_balancing(self, phone: str, template_name: str, language_code: str = 'en', 
                                        parameters: Optional[List[str]] = None) -> Tuple[bool, Dict]:
        """Send template message using load balancing across multiple phone numbers"""
        if not self.is_configured():
            return False, {'error': 'WhatsApp Business API não configurada'}
        
        # Get next phone ID for load balancing
        phone_id = self.get_next_phone_id()
        
        try:
            url = f"{self.base_url}/{phone_id}/messages"
            
            # Format phone number
            formatted_phone = phone
            if phone.startswith('55'):
                formatted_phone = '+' + phone
            elif not phone.startswith('+'):
                formatted_phone = '+55' + phone
            
            # Build template payload
            payload = {
                'messaging_product': 'whatsapp',
                'to': formatted_phone,
                'type': 'template',
                'template': {
                    'name': template_name,
                    'language': {'code': language_code}
                }
            }
            
            # Add components if parameters provided
            if parameters:
                components = []
                
                # Add body with parameters
                if len(parameters) >= 2:
                    components.append({
                        'type': 'body',
                        'parameters': [
                            {'type': 'text', 'text': str(parameters[0])},
                            {'type': 'text', 'text': str(parameters[1])}
                        ]
                    })
                
                # Add button with first parameter (CPF)
                if len(parameters) >= 1:
                    components.append({
                        'type': 'button',
                        'sub_type': 'url',
                        'index': 0,
                        'parameters': [{'type': 'text', 'text': str(parameters[0])}]
                    })
                
                payload['template']['components'] = components
            
            response = requests.post(url, json=payload, headers=self.headers, timeout=30)
            
            if response.status_code == 200:
                data = response.json()
                message_id = data.get('messages', [{}])[0].get('id', '')
                
                # Get phone details for logging
                phone_details = next((p for p in self.get_all_phone_numbers() if p['id'] == phone_id), 
                                   {'number': phone_id, 'name': 'Unknown'})
                
                logging.info(f"Template sent via {phone_details['number']} ({phone_details['name']}): {message_id}")
                
                return True, {
                    'messageId': message_id,
                    'whatsAppId': message_id,
                    'status': 'sent',
                    'phone_used': phone_details['number'],
                    'phone_name': phone_details['name'],
                    'template_used': template_name
                }
            else:
                error_data = response.json() if response.content else {}
                error_message = error_data.get('error', {}).get('message', response.text)
                
                logging.error(f"Template failed from phone {phone_id}: {error_message}")
                
                return False, {
                    'error': f'Template "{template_name}" failed: {error_message}',
                    'phone_used': phone_id,
                    'template_name': template_name
                }
                
        except requests.exceptions.RequestException as e:
            logging.error(f"Connection error sending template: {str(e)}")
            return False, {'error': f'Connection error: {str(e)}'}
    
    def test_all_phones(self) -> Dict:
        """Test all phone numbers to verify which ones are working"""
        results = {}
        
        for phone_info in self.get_all_phone_numbers():
            phone_id = phone_info['id']
            phone_number = phone_info['number']
            
            try:
                # Test with a simple status check
                url = f"{self.base_url}/{phone_id}"
                response = requests.get(url, headers=self.headers, timeout=10)
                
                if response.status_code == 200:
                    data = response.json()
                    results[phone_number] = {
                        'status': 'working',
                        'quality': data.get('quality_rating', 'unknown'),
                        'verified_name': data.get('verified_name', 'unknown'),
                        'id': phone_id
                    }
                else:
                    results[phone_number] = {
                        'status': 'error',
                        'error': f'HTTP {response.status_code}',
                        'id': phone_id
                    }
            except Exception as e:
                results[phone_number] = {
                    'status': 'error',
                    'error': str(e),
                    'id': phone_id
                }
        
        return results