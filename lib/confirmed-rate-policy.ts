export function compatibleConfirmedRate(item:{description:string;unit:string|null;trade_category_id:number},rate:{description:string;unit:string;trade_category_id:number;state:string|null;active:boolean},state:string|null):boolean {
 return rate.active && rate.state===state && item.trade_category_id===rate.trade_category_id && item.unit!==null && item.unit.trim().toLowerCase()===rate.unit.trim().toLowerCase() && item.description.trim().toLowerCase()===rate.description.trim().toLowerCase()
}
// Packages are not interchangeable with one component even when words overlap.
export function incompatiblePackageSelection(item:string,fact:string):boolean {
 const packageItem=/cabinetry|joinery|package|fitout|fit-out/i.test(item)
 const component=/mixer|tapware|tap\b|sink|handle|hinge/i.test(fact)
 return packageItem && component && !/cabinetry|joinery|package|fitout|fit-out/i.test(fact)
}
