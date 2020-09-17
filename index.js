"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Strategy = void 0;
/**
 * Apereo CAS Protocol Client (https://apereo.github.io/cas/6.1.x/protocol/CAS-Protocol.html)
 */
const url = require("url");
const axios = require("axios");
const passport = require("passport");
const uuid_1 = require("uuid");
const xml2js = require("xml2js");
class Strategy extends passport.Strategy {
    constructor(options, verify) {
        super();
        this.name = 'cas';
        this.version = options.version || 'CAS1.0';
        this.casBaseURL = new url.URL(options.casBaseURL).toString();
        this.serviceBaseURL = new url.URL(options.serviceBaseURL).toString();
        this.validateURL = options.validateURL;
        this.serviceURL = options.serviceURL;
        this.useSaml = options.useSaml || false;
        this._verify = verify;
        this._client = axios.default.create(options.agentOptions);
        this._passReqToCallback = options.passReqToCallback || false;
        if (!['CAS1.0', 'CAS2.0', 'CAS3.0'].includes(this.version)) {
            throw new Error(`Unsupported CAS protocol version: ${this.version}`);
        }
    }
    verify(req, profile) {
        return new Promise((resolve, reject) => {
            const verified = (err, user, info) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve({ user: user || false, info });
            };
            if (this._passReqToCallback) {
                this._verify(req, profile, verified);
            }
            else {
                this._verify(profile, verified);
            }
        });
    }
    validateCAS1(req, result) {
        return __awaiter(this, void 0, void 0, function* () {
            if (result.length < 2 || result[0] !== 'yes' || result[1] === '') {
                return { profile: false, info: 'Authentication failed' };
            }
            return { profile: result[1] };
        });
    }
    ;
    validateSAML(req, result) {
        return __awaiter(this, void 0, void 0, function* () {
            const response = result.envelope.body.response;
            const success = response.status.statuscode['$'].Value.match(/Success$/);
            if (!success) {
                return { profile: false, info: 'Authentication failed' };
            }
            const attributes = {};
            if (Array.isArray(response.assertion.attributestatement.attribute)) {
                for (const attribute of response.assertion.attributestatement.attribute) {
                    attributes[attribute['$'].AttributeName.toLowerCase()] = attribute.attributevalue;
                }
                ;
            }
            const profile = {
                'user': response.assertion.authenticationstatement.subject.nameidentifier,
                'attributes': attributes
            };
            return { profile };
        });
    }
    validateCAS23(req, result) {
        return __awaiter(this, void 0, void 0, function* () {
            const failure = result.serviceresponse.authenticationfailure;
            if (failure) {
                const code = failure.$ && failure.$.code;
                return { profile: false, info: `Authentication failed: Reason: ${code || 'UNKNOWN'}` };
            }
            const profile = result.serviceresponse.authenticationsuccess;
            if (!profile) {
                return { profile: false, info: 'Authentication failed: Missing profile' };
            }
            return { profile };
        });
    }
    service(req) {
        const serviceURL = this.serviceURL || req.originalUrl;
        const resolvedURL = new url.URL(serviceURL, this.serviceBaseURL);
        resolvedURL.searchParams.delete('ticket');
        return resolvedURL.toString();
    }
    ;
    authenticate(req, options) {
        Promise.resolve().then(() => __awaiter(this, void 0, void 0, function* () {
            options = options || {};
            // CAS Logout flow as described in
            // https://wiki.jasig.org/display/CAS/Proposal%3A+Front-Channel+Single+Sign-Out var relayState = req.query.RelayState;
            const relayState = req.query.RelayState;
            if (typeof relayState === 'string' && relayState) {
                // logout locally
                req.logout();
                const redirectURL = new url.URL('./logout', this.casBaseURL);
                redirectURL.searchParams.append('_eventId', 'next');
                redirectURL.searchParams.append('RelayState', relayState);
                this.redirect(redirectURL.toString());
                return;
            }
            const service = this.service(req);
            const ticket = req.query.ticket;
            if (!ticket) {
                const redirectURL = new url.URL('./login', this.casBaseURL);
                redirectURL.searchParams.append('service', service);
                // copy loginParams in login query
                const loginParams = options.loginParams;
                if (loginParams) {
                    for (const loginParamKey in loginParams) {
                        if (loginParams.hasOwnProperty(loginParamKey)) {
                            const loginParamValue = loginParams[loginParamKey];
                            if (loginParamValue) {
                                redirectURL.searchParams.append(loginParamValue, loginParamValue);
                            }
                        }
                    }
                }
                this.redirect(redirectURL.toString());
                return;
            }
            let profileInfo;
            if (this.useSaml) {
                const soapEnvelope = `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Header/><SOAP-ENV:Body><samlp:Request xmlns:samlp="urn:oasis:names:tc:SAML:1.0:protocol" MajorVersion="1" MinorVersion="1" RequestID="${uuid_1.v4()}" IssueInstant="${new Date().toISOString()}"><samlp:AssertionArtifact>${ticket}</samlp:AssertionArtifact></samlp:Request></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
                const validateURL = new url.URL(this.validateURL || './samlValidate', this.casBaseURL).toString();
                try {
                    const response = yield this._client.post(validateURL, soapEnvelope, {
                        params: {
                            TARGET: service,
                        },
                        headers: {
                            'Content-Type': 'application/xml',
                            'Accept': 'application/xml',
                            'Accept-Charset': 'utf-8',
                        },
                        responseType: 'text',
                    });
                    const result = yield xml2js.parseStringPromise(response.data, {
                        'trim': true,
                        'normalize': true,
                        'explicitArray': false,
                        'tagNameProcessors': [
                            xml2js.processors.normalize,
                            xml2js.processors.stripPrefix
                        ]
                    });
                    profileInfo = yield this.validateSAML(req, result);
                }
                catch (err) {
                    this.fail(String(err), 500);
                    return;
                }
            }
            else {
                let validateURL;
                switch (this.version) {
                    default:
                    case 'CAS1.0':
                        validateURL = new url.URL(this.validateURL || './validate', this.casBaseURL).toString();
                        break;
                    case 'CAS2.0':
                        validateURL = new url.URL(this.validateURL || './serviceValidate', this.casBaseURL).toString();
                        break;
                    case 'CAS3.0':
                        validateURL = new url.URL(this.validateURL || './p3/serviceValidate', this.casBaseURL).toString();
                        break;
                }
                try {
                    const response = yield this._client.get(validateURL, {
                        params: {
                            ticket: ticket,
                            service: service,
                        },
                        headers: {
                            'Accept': 'application/xml',
                            'Accept-Charset': 'utf-8',
                        },
                        responseType: 'text',
                    });
                    switch (this.version) {
                        default:
                        case 'CAS1.0': {
                            const result = response.data.split('\n').map((s) => s.trim());
                            profileInfo = yield this.validateCAS1(req, result);
                            break;
                        }
                        case 'CAS2.0':
                        case 'CAS3.0': {
                            const result = yield xml2js.parseStringPromise(response.data, {
                                'trim': true,
                                'normalize': true,
                                'explicitArray': false,
                                'tagNameProcessors': [
                                    xml2js.processors.normalize,
                                    xml2js.processors.stripPrefix
                                ]
                            });
                            profileInfo = yield this.validateCAS23(req, result);
                            break;
                        }
                    }
                }
                catch (err) {
                    this.fail(String(err), 500);
                    return;
                }
            }
            if (profileInfo.profile === false) {
                this.fail(profileInfo.info);
                return;
            }
            let userInfo;
            try {
                userInfo = yield this.verify(req, profileInfo.profile);
            }
            catch (err) {
                this.error(err);
                return;
            }
            // Support `info` of type string, even though it is
            // not supported by the passport type definitions.
            // Recommend use of an object like `{ message: 'Failed' }`
            if (!userInfo.user) {
                const info = userInfo.info;
                if (typeof info === 'string') {
                    this.fail(info);
                }
                else if (!info || !info.message) {
                    this.fail();
                }
                else {
                    this.fail(info.message);
                }
                return;
            }
            this.success(userInfo.user, userInfo.info);
        }))
            .catch((err) => {
            this.error(err);
            return;
        });
    }
    ;
}
exports.Strategy = Strategy;
