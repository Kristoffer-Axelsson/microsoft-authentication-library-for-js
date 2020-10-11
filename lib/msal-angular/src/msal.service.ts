import { Inject, Injectable } from "@angular/core";
import {
    UserAgentApplication,
    Configuration,
    AuthenticationParameters,
    AuthResponse,
    AuthError,
    authResponseCallback,
    errorReceivedCallback,
    tokenReceivedCallback,
    UrlUtils
} from "@azure/msal-browser";
import { Router } from "@angular/router";
import {BroadcastService} from "./broadcast.service";
import { MSALError } from "./MSALError";
import { MsalAngularConfiguration } from "./msal-angular.configuration";
import { MSAL_CONFIG, MSAL_CONFIG_ANGULAR } from "./constants";

import { Minimatch } from "minimatch";

const buildMsalConfig = (config: Configuration) : Configuration => {
    return {
        ...config,
        framework: {
            ...config.framework,
            isAngular: true
        }
    };
};

@Injectable()
export class MsalService extends UserAgentApplication {

    constructor(
        @Inject(MSAL_CONFIG) private msalConfig: Configuration,
        @Inject(MSAL_CONFIG_ANGULAR) private msalAngularConfig: MsalAngularConfiguration,
        private router: Router,
        private broadcastService: BroadcastService
    ) {
        super(buildMsalConfig(msalConfig));

        window.addEventListener("msal:popUpHashChanged", (e: CustomEvent) => {
            this.getLogger().verbose("popUpHashChanged ");
        });

        window.addEventListener("msal:popUpClosed", (e: CustomEvent) => {
            const errorParts = e.detail.split("|");
            const msalError = new MSALError(errorParts[0], errorParts[1]);
            if (this.getLoginInProgress()) {
                broadcastService.broadcast("msal:loginFailure", msalError);
                this.setloginInProgress(false);
            }
            else if (this.getAcquireTokenInProgress()) {
                broadcastService.broadcast("msal:acquireTokenFailure", msalError);
                this.setAcquireTokenInProgress(false);
            }
        });
    }

    public loginPopup(request?: AuthenticationParameters): Promise<any> {
        return super.loginPopup(request)
            .then((authResponse: AuthResponse) => {
                this.broadcastService.broadcast("msal:loginSuccess", authResponse);
                return authResponse;
            })
            .catch((error: AuthError) => {
                this.broadcastService.broadcast("msal:loginFailure", error);
                this.getLogger().error("Error during login:\n" + error.errorMessage);
                throw error;
            });
    }

    public ssoSilent(request: AuthenticationParameters): Promise<AuthResponse> {
        return super.ssoSilent(request)
            .then((authResponse: AuthResponse) => {
                this.broadcastService.broadcast("msal:ssoSuccess", authResponse);
                return authResponse;
            })
            .catch((error: AuthError) => {
                this.broadcastService.broadcast("msal:ssoFailure", error);
                this.getLogger().error("Error during login:\n" + error.errorMessage);
                throw error;
            });
    }

    public acquireTokenSilent(request: AuthenticationParameters): Promise<AuthResponse> {
        return super.acquireTokenSilent(request)
            .then((authResponse: AuthResponse) => {
                this.broadcastService.broadcast("msal:acquireTokenSuccess", authResponse);
                return authResponse;
            })
            .catch((error: AuthError) => {
                this.broadcastService.broadcast("msal:acquireTokenFailure", error);
                this.getLogger().error("Error when acquiring token for scopes: " + request.scopes + " " + error);
                throw error;
            });

    }

    public acquireTokenPopup(request: AuthenticationParameters): Promise<AuthResponse> {
        return super.acquireTokenPopup(request)
            .then((authResponse: AuthResponse) => {
                this.broadcastService.broadcast("msal:acquireTokenSuccess", authResponse);
                return authResponse;
            })
            .catch((error: AuthError) => {
                this.broadcastService.broadcast("msal:acquireTokenFailure", error);
                this.getLogger().error("Error when acquiring token for scopes : " + request.scopes + " " +  error);
                throw error;
            });
    }

    handleRedirectCallback(tokenReceivedCallback: tokenReceivedCallback, errorReceivedCallback: errorReceivedCallback): void;
    handleRedirectCallback(authCallback: authResponseCallback): void;
    handleRedirectCallback(authOrTokenCallback: authResponseCallback | tokenReceivedCallback, errorReceivedCallback?: errorReceivedCallback): void {
        super.handleRedirectCallback((authError: AuthError, authResponse: AuthResponse) => {
            if (authError) {
                if (!this.getAccount()) {
                    this.broadcastService.broadcast("msal:loginFailure", authError);

                } else {
                    this.broadcastService.broadcast("msal:acquireTokenFailure", authError);
                }

                if (errorReceivedCallback) {
                    errorReceivedCallback(authError, authResponse.accountState);
                } else {
                    (authOrTokenCallback as authResponseCallback)(authError, authResponse);
                }

            } else if (authResponse) {
                if (authResponse.tokenType === "id_token") {
                    this.broadcastService.broadcast("msal:loginSuccess", authResponse);
                } else {
                    this.broadcastService.broadcast("msal:acquireTokenSuccess", authResponse);
                }

                if (errorReceivedCallback) {
                    (authOrTokenCallback as tokenReceivedCallback)(authResponse);
                } else {
                    (authOrTokenCallback as authResponseCallback)(null, authResponse);
                }

            }
        });
    }

    public clearCacheForScope(accessToken: string) {
        return super.clearCacheForScope(accessToken);
    }

    public getScopesForEndpoint(endpoint: string) : Array<string> {
        if ((this.msalConfig.framework && this.msalConfig.framework.unprotectedResources) || (this.msalAngularConfig && this.msalAngularConfig.unprotectedResources)) {
            this.getLogger().info("unprotectedResources is deprecated and ignored. msalAngularConfig.protectedResourceMap now supports glob patterns");
        }

        const frameworkProtectedResourceMap = this.msalConfig.framework && this.msalConfig.framework.protectedResourceMap;
        if (frameworkProtectedResourceMap) {
            this.getLogger().info("msalConfig.framework.protectedResourceMap is deprecated, use msalAngularConfig.protectedResourceMap");
        }

        const protectedResourceMap = frameworkProtectedResourceMap && frameworkProtectedResourceMap.size ? frameworkProtectedResourceMap : new Map(this.msalAngularConfig.protectedResourceMap);
        
        const protectedResourcesArray = Array.from(protectedResourceMap.keys());
        const keyMatchesEndpointArray = protectedResourcesArray.filter(key => {
            const minimatch = new Minimatch(key);
            return minimatch.match(endpoint) || endpoint.indexOf(key) > -1;
        });
        
        // process all protected resources and send the first matched resource
        if (keyMatchesEndpointArray.length > 0) {
            if (keyMatchesEndpointArray.length > 1) {
                this.getLogger().warning("Multiple entries in protectedResourceMap found for resource. Using first entry.");
                this.getLogger().warningPii(`Multiple entries found for: ${endpoint}`);
            }
            const keyForEndpoint = keyMatchesEndpointArray[0];
            if (keyForEndpoint) {
                return protectedResourceMap.get(keyForEndpoint);
            }
        } 

        /*
         * default resource will be clientid if nothing specified
         * App will use idtoken for calls to itself
         * check if it's staring from http or https, needs to match with app host
         */
        if (endpoint.indexOf("http://") > -1 || endpoint.indexOf("https://") > -1) {
            if (UrlUtils.getHostFromUri(endpoint) === UrlUtils.getHostFromUri(super.getRedirectUri())) {
                return new Array<string>(this.msalConfig.auth.clientId);
            }
        } else {
            /*
             * in angular level, the url for $http interceptor call could be relative url,
             * if it's relative call, we'll treat it as app backend call.
             */
            return new Array<string>(this.msalConfig.auth.clientId);
        }

        // if not the app's own backend or not a domain listed in the endpoints structure
        return null;
    }
}
