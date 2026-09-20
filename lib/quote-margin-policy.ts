import { financialProfile, EMPTY_PROFILE, sumMoney, type FinancialProfile } from './profitability.ts'
export function quoteMarginPolicy(cost: number, price: number, profile: Partial<FinancialProfile> | null) {
  const margin = price > 0 ? (price-cost)/price*100 : null
  const business = profile ? financialProfile({...EMPTY_PROFILE,...profile}) : null
  const minimum = business?.viable ? business.minimumMargin : null
  const required = minimum === null || margin === null || margin < minimum
  return {cost:sumMoney([cost]),price:sumMoney([price]),margin,minimum,required,
    message:minimum===null?'Business overheads have not established a sustainable margin. Complete your business profile or record why you are sending this quote.':required?`This quote has ${margin?.toFixed(1)??'no'}% gross margin; your overheads require ${minimum.toFixed(1)}%. Reprice or record your reason for accepting the shortfall.`:`Gross margin ${margin!.toFixed(1)}% covers your ${minimum.toFixed(1)}% overhead requirement.`}
}
