interface HeaderProps {
  title?: string;
  subtitle?: string;
}

export function Header({ title, subtitle }: HeaderProps) {
  return (
    <header className="bg-white border-b border-[#E2E8F0] shadow-sm">
      <div className="px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-3">
              <img 
                src="/assets/overdrive-logo.png" 
                alt="Overdrive" 
                className="h-10 w-auto"
                data-testid="logo-overdrive"
              />
              <div className="h-8 w-px bg-[#E2E8F0]"></div>
              {title && (
                <div>
                  <h1 
                    className="text-xl font-semibold text-[#1A202C]" 
                    data-testid="text-page-title"
                  >
                    {title}
                  </h1>
                  {subtitle && (
                    <p 
                      className="text-sm text-[#A0AEC0] mt-0.5" 
                      data-testid="text-page-subtitle"
                    >
                      {subtitle}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#F7FAFC] border border-[#E2E8F0]">
              <div className="w-2 h-2 bg-[#38A169] rounded-full"></div>
              <span className="text-sm text-[#38A169] font-medium" data-testid="status-api">
                API Ativa
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
