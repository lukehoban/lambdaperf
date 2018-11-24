import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

// Test Infrastructure
const table = new aws.dynamodb.Table("stats", {
    attributes: [
        { name: "test", type: "S" },
        { name: "val", type: "N" }
    ],
    hashKey: "test",
    rangeKey: "val",
    readCapacity: 5,
    writeCapacity: 100,
});
const NUM_DATAPOINTS = 500;
async function harness(name: string, val: number, action: (newval: number) => Promise<any>) {
    if(val == NUM_DATAPOINTS) {
        return;
    }
    const start = Date.now();
    const resp = action(val+1);
    const end = Date.now();
    const ddb = new aws.sdk.DynamoDB.DocumentClient();
    const ddbresp = await ddb.put({
        TableName: table.name.get(),
        Item: { test: name, val, start, end },
    }).promise();
    const res = await resp;
    const ddbres = await ddbresp;
}

// Test for Bucket
const bucket = new aws.s3.Bucket("my-bucket");
function sendBucketValue(val: number) {
    const s3 = new aws.sdk.S3();
    return s3.putObject({
        Bucket: bucket.id.get(),
        Body: "",
        Key: val.toString(),
    }).promise();
}
const bucketSubscription = bucket.onObjectCreated("onobject", async (ev, ctx) => {
    await harness("s3", Number(ev.Records![0].s3.object.key), sendBucketValue);
});

// Test for Topic
const topic = new aws.sns.Topic("my-topic");
function sendTopicValue(val: number) {
    return (new aws.sdk.SNS()).publish({
        TopicArn: topic.arn.get(),
        Message: val.toString(),
    }).promise();
}
const topicSubscription = topic.onEvent("ontopicevent", (ev, ctx) => {
    return harness("sns", Number(ev.Records[0].Sns.Message), sendTopicValue);
});

// Test for Queue
const queue = new aws.sqs.Queue("my-queue", {
    visibilityTimeoutSeconds: 180,
});
function sendQueueValue(val: number) {
    return (new aws.sdk.SQS()).sendMessage({
        QueueUrl: queue.id.get(),
        MessageBody: val.toString(),
    }).promise();
}
const queueSubscription = queue.onEvent("onqueueevent", (ev, ctx) => {
    return harness("sqs", Number(ev.Records[0].body), sendQueueValue);
}, { batchSize: 1});

// Test for Table
const tab = new aws.dynamodb.Table("my-table", {
    attributes: [
        { name: "val", type: "N" }
    ],
    hashKey: "val",
    readCapacity: 5,
    writeCapacity: 100,
    streamEnabled: true,
    streamViewType: "NEW_IMAGE",
});
function sendTableValue(val: number) {
    return (new aws.sdk.DynamoDB.DocumentClient()).put({
        TableName: tab.name.get(),
        Item: { val: val, r: Math.random() },
    }).promise();
}
const tableSubscription = tab.onEvent("onTableEvent", (ev, ctx) => {
    return harness("table", Number(ev.Records[0].dynamodb.NewImage!.val.N), sendTableValue);
}, { startingPosition: "LATEST" });

function renderChart(arr: {text: string; values: number[]}[], minVal: number, maxVal: number) {
    return `<!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <!--Script Reference[1]-->
      <script src="https://cdn.zingchart.com/zingchart.min.js"></script>
    </head>
    <body>
      <div id="chartDiv"></div>
      <script>
        var chartData = {
          type: 'line',
          legend: {
            "vertical-align": "middle",
          },
          "scale-y": {
            "min-value": ${minVal},
            "max-value": ${maxVal},
          },
          title: {
            text: 'Lambda Event Source Latency'
          },
          series: ${JSON.stringify(arr)}
        };
        zingchart.render({ // Render Method[3]
          id: 'chartDiv',
          data: chartData,
          height: 400,
          width: 600
        });
      </script>
    </body>
    </html>`;
}

const api = new aws.apigateway.x.API("api", {
    routes: [
        { path: "/", method: "GET", eventHandler: async (ev, ctx) => {
            await Promise.all([
                sendTopicValue(0), 
                sendQueueValue(0), 
                sendBucketValue(0),
                sendTableValue(0),
            ]);
            return { statusCode: 200, body: "" };
        }},
        { path: "/chart", method: "GET", eventHandler: async (ev, ctx) => {
            const ddb = new aws.sdk.DynamoDB.DocumentClient();
            const scanResults = await ddb.scan({
                TableName: table.name.get(),
            }).promise();
            if (scanResults.Items) {
                const numbers: number[] = [];
                var series: {[key: string]: number[]} = {}
                for(const item of scanResults.Items) {
                    if (!series[item.test]) {
                        series[item.test] = [];
                    }
                    series[item.test][item.val] = item.start;
                    numbers.push(Number(item.start));
                }
                var arr: {text: string; values: number[]}[] = [];
                for(const key in series) {
                    const keyMin = Math.min(...series[key]);
                    const keyMax = Math.max(...series[key]);
                    const latency = (keyMax - keyMin)/series[key].length;
                    arr.push({
                        text: `${key} (${Math.floor(latency)}ms)`,
                        values: series[key]
                    });
                }
                const minVal = Math.min(...numbers);
                const maxVal = Math.max(...numbers);
                return { statusCode: 200, body: renderChart(arr, minVal, maxVal), headers: { "Content-Type": "text/html" }};
            }
            return { statusCode: 500, body: "No items returned!" }
        }},
    ],
})
export const endpoint = api.url;
export const chartEndpoint = api.url.apply(url => `${url}chart`);
