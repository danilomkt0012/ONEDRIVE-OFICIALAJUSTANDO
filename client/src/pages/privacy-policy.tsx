export default function PrivacyPolicyPage() {
  return (
    <div className="min-h-screen bg-[#F5F7FA] py-12 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-sm p-8 md:p-12">
        <h1 className="text-3xl font-bold text-[#1A202C] mb-2">
          Política de Privacidade
        </h1>
        <p className="text-sm text-[#718096] mb-8">
          Última atualização: abril de 2026
        </p>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">1. Introdução</h2>
          <p className="text-[#4A5568] leading-relaxed">
            A plataforma OVERDRIVE ("nós", "nosso" ou "Plataforma") valoriza a privacidade dos seus usuários e
            dos contatos gerenciados por meio do sistema. Esta Política de Privacidade descreve como coletamos,
            usamos, armazenamos e compartilhamos informações pessoais no âmbito da utilização da nossa plataforma
            de automação e envio de mensagens via WhatsApp Business API.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">2. Dados Coletados</h2>
          <p className="text-[#4A5568] leading-relaxed mb-3">
            Coletamos as seguintes categorias de dados pessoais:
          </p>
          <ul className="list-disc list-inside text-[#4A5568] leading-relaxed space-y-2">
            <li>
              <strong>Dados de cadastro:</strong> nome, endereço de e-mail, senha (armazenada de forma criptografada)
              e demais informações fornecidas no momento do registro na Plataforma.
            </li>
            <li>
              <strong>Dados de contatos importados:</strong> números de telefone, nomes e quaisquer atributos
              adicionais incluídos nas listas de leads carregadas pelos usuários.
            </li>
            <li>
              <strong>Dados de uso:</strong> logs de acesso, histórico de campanhas, interações com o chatbot e
              métricas de entrega de mensagens.
            </li>
            <li>
              <strong>Dados técnicos:</strong> endereço IP, tipo de navegador, identificadores de dispositivo e
              informações de sessão.
            </li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">3. Uso das Informações</h2>
          <p className="text-[#4A5568] leading-relaxed mb-3">
            Utilizamos os dados coletados para as seguintes finalidades:
          </p>
          <ul className="list-disc list-inside text-[#4A5568] leading-relaxed space-y-2">
            <li>Autenticação e gerenciamento de contas de usuário;</li>
            <li>Processamento e envio de campanhas de mensagens via WhatsApp Business API;</li>
            <li>Operação do chatbot automatizado e gestão de conversas;</li>
            <li>Monitoramento e melhoria contínua da Plataforma;</li>
            <li>Comunicações operacionais e de suporte ao usuário;</li>
            <li>Cumprimento de obrigações legais e regulatórias.</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">4. Uso da WhatsApp Business API e Compartilhamento com a Meta</h2>
          <p className="text-[#4A5568] leading-relaxed">
            A Plataforma utiliza a WhatsApp Business API, fornecida pela Meta Platforms, Inc., para o envio e
            recebimento de mensagens. Ao utilizar nossos serviços, os dados de mensagens — incluindo números de
            telefone dos destinatários e o conteúdo das mensagens enviadas — são processados pela infraestrutura
            da Meta de acordo com os{" "}
            <a
              href="https://www.whatsapp.com/legal/business-policy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#3182CE] underline"
            >
              Termos de Serviço do WhatsApp Business
            </a>{" "}
            e a{" "}
            <a
              href="https://www.facebook.com/privacy/policy/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#3182CE] underline"
            >
              Política de Privacidade da Meta
            </a>
            . Não vendemos dados pessoais a terceiros.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">5. Armazenamento e Segurança dos Dados</h2>
          <p className="text-[#4A5568] leading-relaxed">
            Os dados são armazenados em servidores seguros com acesso restrito. Adotamos medidas técnicas e
            organizacionais adequadas para proteger as informações contra acesso não autorizado, perda,
            destruição ou divulgação indevida, incluindo criptografia de senhas e comunicações via HTTPS.
            Os dados são mantidos pelo tempo necessário para a prestação dos serviços ou enquanto exigido pela
            legislação aplicável.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">6. Retenção de Dados</h2>
          <p className="text-[#4A5568] leading-relaxed">
            Retemos dados pessoais pelo período necessário para o cumprimento das finalidades descritas nesta
            Política, salvo quando a retenção por período superior for exigida ou permitida por lei. Após o
            encerramento da conta, dados poderão ser mantidos por até 90 (noventa) dias para fins de backup e
            segurança, sendo então anonimizados ou excluídos.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">7. Direitos dos Titulares (LGPD)</h2>
          <p className="text-[#4A5568] leading-relaxed mb-3">
            Em conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — LGPD), os titulares de
            dados pessoais têm os seguintes direitos:
          </p>
          <ul className="list-disc list-inside text-[#4A5568] leading-relaxed space-y-2">
            <li>Confirmação da existência de tratamento de seus dados;</li>
            <li>Acesso aos dados pessoais armazenados;</li>
            <li>Correção de dados incompletos, inexatos ou desatualizados;</li>
            <li>Anonimização, bloqueio ou eliminação de dados desnecessários ou tratados em desconformidade;</li>
            <li>Portabilidade dos dados a outro fornecedor de serviço;</li>
            <li>Eliminação dos dados pessoais tratados com base no consentimento;</li>
            <li>Revogação do consentimento a qualquer momento.</li>
          </ul>
          <p className="text-[#4A5568] leading-relaxed mt-3">
            Para exercer seus direitos, entre em contato conosco pelos canais indicados na seção abaixo.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">8. Cookies e Tecnologias Semelhantes</h2>
          <p className="text-[#4A5568] leading-relaxed">
            A Plataforma pode utilizar cookies de sessão e tecnologias semelhantes para manter o usuário
            autenticado e melhorar a experiência de uso. Esses cookies não rastreiam atividades fora da
            Plataforma e são estritamente necessários para o funcionamento do sistema.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">9. Alterações nesta Política</h2>
          <p className="text-[#4A5568] leading-relaxed">
            Esta Política de Privacidade pode ser atualizada periodicamente. Notificaremos os usuários sobre
            mudanças significativas por e-mail ou por aviso destacado na Plataforma. Recomendamos a revisão
            periódica desta página para manter-se informado.
          </p>
        </section>

        <section className="mb-4">
          <h2 className="text-xl font-semibold text-[#2D3748] mb-3">10. Contato</h2>
          <p className="text-[#4A5568] leading-relaxed">
            Em caso de dúvidas, solicitações ou exercício de direitos relacionados a esta Política de
            Privacidade, entre em contato com o nosso Encarregado de Proteção de Dados (DPO) pelo e-mail:{" "}
            <a
              href="mailto:privacidade@overdrive.app"
              className="text-[#3182CE] underline"
            >
              privacidade@overdrive.app
            </a>
            .
          </p>
        </section>

        <hr className="border-[#E2E8F0] mt-8 mb-6" />
        <p className="text-xs text-[#A0AEC0] text-center">
          OVERDRIVE &mdash; Plataforma de Automação WhatsApp Business
        </p>
      </div>
    </div>
  );
}
