import * as dgram from "dgram";
import * as net from "net";
import * as os from "os";
import * as winston from "winston";
import Transport from 'winston-transport';
import { LogstashOption } from "./LogstashOption";
import debugging from "debug";

const debug = debugging("winston-logstash-ts:LogStashTransport");

export class LogstashTransport extends Transport {

  public readonly name = "LogstashTransport";
  protected host: string;
  protected port: number;
  protected protocol: "tcp" | "udp";
  protected debug: debug.Debugger;

  protected tcpKeepAliveInitialDelay: number = 0;

  constructor(options?: LogstashOption) {
    super(options);
    this.host = options.host;
    this.port = options.port;
    this.silent = options.silent;
    this.protocol = options.protocol || "udp"
    this.tcpKeepAliveInitialDelay = options.tcpKeepAliveInitialDelay || 0;
  }

  public async connect() {
    if (this.protocol === "udp") {
      // https://www.elastic.co/guide/en/logstash/current/plugins-inputs-udp.html#buffer_size
      // maximum byte size is default to 65536
      const udpClient = dgram.createSocket({
        type: 'udp4',
        sendBufferSize: 65536
      });
      udpClient.unref();
      return udpClient;
    } else if (this.protocol === "tcp") {
      return new Promise<net.Socket>((resolve, reject) => {
        const tcpClient = new net.Socket();

        const errorListener = (error) => {
          debug.color = "196";
          debug("%o", error);
          tcpClient.destroy();
          tcpClient.removeListener("error", connectListener);
          reject(error);
        }

        const connectListener = () => {
          debug.color = "46";
          debug("TCP connection to %s:%d has been established.", this.host, this.port);
          // tcpClient.setKeepAlive(true, this.tcpKeepAliveInitialDelay);
          // tcpClient.unref();
          tcpClient.removeListener("connect", connectListener);
          resolve(tcpClient);
        };

        tcpClient.on("error", errorListener)
        tcpClient.on("connect", connectListener);
        tcpClient.on("close", () => {
          debug.color = "196";
          debug("TCP connection to %s:%d has been closed.", this.host, this.port);
        });
        tcpClient.connect(this.port, this.host);
      })
    } else {
      throw new Error("Invalid protocol, only support TCP and UDP.")
    }
  }

  public log(info: any, callback: Function) {
    if (this.silent) {
      return callback(null, true);
    }
    this.send(info[Symbol.for("message")], callback)
      .then((result) => {
        this.emit("logged", result);
      })
      .catch((error) => {
        debug.color = "196"
        debug("An unexpected error occured, transporting to logstash is disabled now.", error.stack);
      })
  }

  public async send(message, callback) {
    const transformed = JSON.stringify(this.format.transform(JSON.parse(message)));
    const buf = Buffer.from(transformed);

    if (this.protocol === "udp") {
      const udpClient: dgram.Socket = (await this.connect()) as dgram.Socket;
      udpClient.send(buf, 0, buf.length, this.port, this.host, (error, bytes) => {
        if (callback) {
          callback(error, bytes);
        }
      });
    } else {
      try {
        const tcpClient: net.Socket = (await this.connect()) as net.Socket;
        await new Promise((resolve, reject) => {
          tcpClient.write(transformed, (error) => {

            if (callback) {
              callback();
            }
            tcpClient.destroy();
            if (error) {
              reject(error);
            } else {
              resolve('');
            }
          });
        });
      } catch (error) {
        if (callback) {
          callback();
        }
        throw error;
      }
    }
  }

  public static createLogger(logType: string, logstashOption: LogstashOption) {
    const appendMetaInfo = winston.format((info) => {
      return Object.assign(info, {
        application: logType || logstashOption.application,
        hostname: logstashOption.hostname || os.hostname(),
        pid: process.pid,
        time: new Date(),
      });
    });

    return winston.createLogger({
      level: logstashOption.level || "info",
      format: winston.format.combine(
        appendMetaInfo(),
        winston.format.json(),
        winston.format.timestamp(),
      ),
      transports: [
        new LogstashTransport(logstashOption) as Transport
      ].concat(logstashOption.transports || [])
    });
  }
}

