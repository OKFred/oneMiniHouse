Array.prototype.math = function ({ operation } = {}) {
    let thisArray = this;
    if (thisArray.length < 2) return undefined;
    let fn =
        operation === "+"
            ? add
            : operation === "-"
            ? subtract
            : operation === "*"
            ? multiply
            : operation === "/"
            ? divide
            : console.log;
    let result = thisArray[0]; //取出第一个值
    for (let i = 1; i < thisArray.length; i++) {
        let num = thisArray[i];
        num = Number(num);
        result = fn(result, num);
        if (!numberCheck(result)) {
            result = undefined;
            return result;
        }
    }
    result = safeNumber(result);
    return result;
}; /* 加减乘除 */

function add(x, y) {
    return x + y;
}
function subtract(x, y) {
    return x - y;
}
function multiply(x, y) {
    return x * y;
}
function divide(x, y) {
    return x / y;
}

function numberCheck(num) {
    return !isNaN(Number(num));
}

function safeNumber(num) {
    return Number(Number(num).toPrecision(15));
}
