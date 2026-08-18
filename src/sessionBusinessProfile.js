export function sessionBusinessProfileFromClient(client) {
  return {
    id: client.businessId,
    name: client.businessName,
    flowType: client.flowType,
    flows: client.flows,
    apiUrl: client.apiUrl,
    apiKey: client.apiKey,
    adminApiUrl: client.adminApiUrl,
    adminApiKey: client.adminApiKey,
    expedientesApiUrl: client.expedientesApiUrl,
    expedientesApiKey: client.expedientesApiKey,
    settings: client.settings
  };
}
