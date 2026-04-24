import "axios";

declare module "axios" {
  interface InternalAxiosRequestConfig {
    __proxyUrl?: string;
    __proxyRetried?: boolean;
  }
}
