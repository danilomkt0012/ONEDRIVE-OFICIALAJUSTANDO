#!/usr/bin/env python3
import requests

def buscar_templates():
    """Buscar todos os templates disponíveis na conta"""
    
    token = 'EAAYLvZBaHbvYBPKCwMnvhXM2kPkWMUlyhVqjtgplZAGrZCRtxZAvH6lZCfP9voDg6UByPd7q6ZBx76kRGMoFsnhBiP7ScXOYD5LqRRppEjc71PRapP1S5oAJCPsoXn9kkPlUMURv53nG0V2wZC5iXZAiZAfSfTGvqsX2NzENeoKDVoura97AZAOxsDd21f97RJJcQSUxfnZBB9x1UkfbUnAU0hLo9N3rZAOwJS4UGLWQwjRVsB0ZD'
    business_id = "746006914691827"
    
    headers = {
        'Authorization': f'Bearer {token}',
        'Content-Type': 'application/json'
    }
    
    print("=== BUSCAR TEMPLATES DA CONTA ===")
    
    # Buscar templates com detalhes completos
    url = f"https://graph.facebook.com/v18.0/{business_id}/message_templates"
    params = {
        'limit': 100,
        'fields': 'name,language,status,category,components'
    }
    
    response = requests.get(url, params=params, headers=headers)
    print(f"Status: {response.status_code}")
    
    if response.status_code == 200:
        data = response.json()
        templates = data.get('data', [])
        
        print(f"Total templates encontrados: {len(templates)}")
        
        for template in templates:
            name = template.get('name', 'N/A')
            language = template.get('language', 'N/A')
            status = template.get('status', 'N/A')
            category = template.get('category', 'N/A')
            components = template.get('components', [])
            
            print(f"\n--- Template: {name} ---")
            print(f"Language: {language}")
            print(f"Status: {status}")
            print(f"Category: {category}")
            print(f"Components: {len(components)}")
            
            # Mostrar detalhes dos componentes para modelo2
            if name == 'modelo2':
                print("🎯 DETALHES DO MODELO2:")
                for i, comp in enumerate(components):
                    print(f"  Component {i+1}: {comp}")
                
                # Se for aprovado, mostrar estrutura exata
                if status == 'APPROVED':
                    print("✅ TEMPLATE MODELO2 APROVADO - ESTRUTURA ENCONTRADA!")
    else:
        print(f"Erro: {response.text}")

if __name__ == "__main__":
    buscar_templates()
