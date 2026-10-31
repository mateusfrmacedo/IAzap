/** Remove generic help-desk openings/closings while retaining the actual answer. */
export function stripServiceOffers(text: string): string {
  const sentences = text.trim().split(/(?<=[.!?])\s+|\n+/u);
  const kept = sentences.filter((sentence) => {
    const normalized = sentence.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
    return !/^(?:(?:oi|ola|bom dia|boa tarde|boa noite)[,!]?\s+)?(?:como posso (?:te |lhe |vos )?ajudar|em que posso (?:te |lhe )?ajudar|(?:eu )?estou aqui para ajudar|posso (?:te |lhe )?ajudar em (?:mais|algo)|se (?:voce )?(?:precisar|quiser).*(?:chamar|ajud|avisar|pedir)|(?:agora[,:]?\s+)?(?:voce )?pode me chamar quando precisar|(?:fico|estou) feliz (?:em ajudar|por ter ajudado))/u.test(normalized);
  });
  const cleaned = kept.join(" ").trim();
  return /\p{L}|\p{N}/u.test(cleaned) ? cleaned : "";
}
