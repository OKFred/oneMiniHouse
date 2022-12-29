Number.prototype.toCurrency = function () {
    let thisNumber = Number(this);
    let result = thisNumber.toFixed(2);
    return result;
}; /* 货币，保留两位 */

Number.prototype.safeNumber = function safeNumber() {
    return Number(Number(this).toPrecision(15));
}; 
