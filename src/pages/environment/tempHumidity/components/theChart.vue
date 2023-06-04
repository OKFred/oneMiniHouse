<template>
  <view class="ec-container">
    <ec-canvas canvas-id="echart" id="echart" ref="echart" :ec="localObj.echartObj.ec" />
  </view>
  <view style="margin-top: 1vh" />
  <view style="width: 100%" @tap="onToggleGraph">
    <u-button
      :customStyle="`width: 88vw; height: 5vh; background-color: ${localObj.echartObj.buttons.color}; color: white; border-radius: 0.25rem; font-size: 1rem;`">
      {{ localObj.echartObj.buttons.text }}
    </u-button>
  </view>
</template>

<script setup>
//框架引入
import {
  reactive,
  watch,
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  onUpdated,
  getCurrentInstance,
  defineProps,
} from "vue";

//组件引入
// import * as echarts from "/src/components/ec-canvas/echarts.js"; //引入组件

// #ifdef H5
import * as echarts from "echarts";
// #endif

//父系入参
const { onNav, onNavBack, globalData } = globalThis.app;


const props = defineProps({
  localObj: Object,
});

function setData(obj) {
  Object.assign(props.localObj, obj);
}

//本地变量和函数
setData({
  // debug: true,
  echartObj: {
    chart: null,
    ec: {
      // onInit: initChart,
      lazyLoad: true,
    }, // 将 lazyLoad 设为 true 后，需要手动初始化图表
    isLoaded: false,
    isDisposed: false,
    isPaused: false,
    optionObj: {
      animationDuration: 800,
      title: {
        show: false
      },
      tooltip: {
        trigger: 'axis',
        axisPointer: {
          animation: false
        }
      },
      /*       toolbox: {
              feature: {
                saveAsImage: {}
              }
            }, */
      legend: {
        type: 'scroll',
        animation: false,
        data: ['温度(℃)', '湿度(%)']
      },
      grid: {
        left: '3%',
        right: '4%',
        bottom: '1%',
        containLabel: true
      },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: [],
        splitLine: {
          show: false
        }
      },
      yAxis: {
        type: 'value',
        splitLine: {
          show: false
        }
      },
      series: [
        {
          name: '温度(℃)',
          type: 'line',
          smooth: true,
          data: [],
        },
        {
          name: '湿度(%)',
          type: 'line',
          smooth: true,
          data: [],
        }
      ]
    },
    initChart,
    dispose,
    buttons: {
      text: "加载中",
      color: '#ff5722',
    },
  }
});

let graphInterval = null; //定时器
//echarts中需要用到instance
let proxy, instance;
onMounted(() => {
  instance = getCurrentInstance();
  proxy = instance.proxy;
  props.localObj.instance = instance;
  props.localObj.proxy = proxy;
  // console.log(instance, proxy);
  //只有在onMounted中才能获取到instance
  console.log('进入页面')
  graphInterval = setInterval(() => {
    if (props.localObj.echartObj.isPaused) return;
    initChart();
  }, 3000)
})

onBeforeUnmount(() => {
  console.log('离开页面')
  clearInterval(graphInterval);
})

function dispose() {
  if (props.localObj.echartObj.chart) {
    props.localObj.echartObj.chart.dispose();
    props.localObj.echartObj.isDisposed = true;
  }
}

function onToggleGraph() {
  console.log('图表状态切换');
  props.localObj.echartObj.isPaused = !props.localObj.echartObj.isPaused;
  props.localObj.echartObj.buttons.text = props.localObj.echartObj.isPaused ? '已暂停' : '加载中';
  props.localObj.echartObj.buttons.color = props.localObj.echartObj.isPaused ? '#03a9f4' : '#ff5722';
}

function initChart() {
  let myChart = instance.refs['echart'];
  if (!myChart) return console.log('图表不存在或者未识别');
  if (globalThis.app.globalData['平台'] === '嵌入网页') {
    let chart = echarts.init(myChart);
    chart.setOption(props.localObj.echartObj.optionObj);
    props.localObj.echartObj.isLoaded = true;
    props.localObj.echartObj.chart = chart;
    return;
  } else {
    myChart.init((canvas, width, height) => {
      const chart = echarts.init(canvas, null, {
        width,
        height,
      });
      canvas.setChart(chart);
      chart.setOption(props.localObj.echartObj.optionObj);
      props.localObj.echartObj.isLoaded = true;
      props.localObj.echartObj.chart = chart;
      return chart;
    })
  }
}
setTimeout(initChart, 500);


watch(
  () => props.localObj.formCollection['主表单'],
  (newValue, oldValue) => {
    if (newValue && newValue.length > 0) {
      let temperatureArr = newValue.map(obj => obj.temperature?.toFixed(2));
      let humidityArr = newValue.map(obj => obj.humidity?.toFixed(2));
      let timeArr = newValue.map(obj => new Date(obj.query_time).Format('hh:mm:ss'));
      let { xAxis, series, legend } = props.localObj.echartObj.optionObj;
      xAxis.data = timeArr;
      let legendArr = ['温度(℃)', '湿度(%)'];
      let dataArr = [temperatureArr, humidityArr];
      // legend.data = legendArr;
      legendArr.forEach((name, index) => {
        series[index] = {
          name,
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: dataArr[index]
        }
      })
    }
  },
  { deep: true },
);

</script>

<style>
.ec-container {
  width: 100%;
  height: 50vh;
}

ec-canvas,
ec-canvas>div {
  display: inline-block;
  width: 100%;
  height: 100%;
}
</style>
