import packageInfo from '../package.json';
import reqJSONTemplateGenerator from './utils/request-json-template-generator';

import winston, { Logger } from 'winston';
import request from 'request-promise';
import fs from 'fs-promise';
import ProgressBar from 'progress';
import path from 'path';
import colors from 'colors/safe';
import jsdom from './utils/jsdom-async';
import JSON from './utils/json-async';

import Album from './Album';
import Photo from './Photo';

class GPhotos {
  constructor ({ username, password, options }) {
    this.username = username;
    this.password = password;
    this.options = options || {};

    this._cookieJar = request.jar();
    this._request = request.defaults({
      simple: false,
      resolveWithFullResponse: true,
      headers: {
        'User-Agent': `Mozilla/5.0 UploadGPhotos/${ packageInfo.version }`
      },
      jar: this._cookieJar
    });
    this._logger = this.options.logger || new Logger({
      transports: [
        new winston.transports.Console({
          colorize: true,
          stderrLevels: ['error', 'warn', 'info', 'verbose', 'debug', 'silly']
        })
      ]
    });
  }

  async login () {
    const loginUrl = 'https://accounts.google.com/ServiceLoginAuth?service=lh2';
    await this._request.get(loginUrl);

    const _GALX =
      this._cookieJar.getCookies(loginUrl)
        .filter((c) => c.key === 'GALX').pop().value;

    const loginData = {
      Email: this.username,
      Passwd: this.password,
      pstMsg: 1,
      GALX: _GALX,
      _utf8: '\u9731',
      bgresponse: 'js_disabled',
      checkedDomains: 'youtube',
      checkConnection: 'youtube:56:1',
      PersistentCookie: 'yes'
    };

    const loginRes = await this._request.post(loginUrl, { form: loginData });

    if (loginRes.statusCode !== 302) {
      this._logger.error('Failed to login...');
      return Promise.reject(new Error('Failed to login'));
    }
    this._logger.info('Success to login!');

    const gplusRes = await this._request.head('https://plus.google.com/u/0/me');
    this._userId = gplusRes.request.uri.href.split('/').reverse()[0];
    this._logger.info(`UserID is ${ this._userId }.`);

    await this.fetchAtParam();

    return this;
  }

  async fetchAtParam () {
    const gPhotosTopPageRes = await this._request.get('https://photos.google.com');
    if (gPhotosTopPageRes.statusCode !== 200) {
      this._logger.error('Can\'t access to Google Photos');
      return Promise.reject(new Error('Can\'t access to Google Photos'));
    }

    this._atParam = await this._generateAtParamFromHTMLAsync(gPhotosTopPageRes.body);
    this._logger.info(`atParam is ${ this._atParam }.`);
  }

  async _generateAtParamFromHTMLAsync (html) {
    const window = await jsdom.envAsync(html);
    if (window.photos_PhotosUi && window.photos_PhotosUi.He) {
      const atParam = window.photos_PhotosUi.He('SNlM0e').wa(null);
      window.close();
      return atParam;
    } else {
      return Promise.reject(new Error('Can\'t generate "at" param.'));
    }
  }

  async searchAlbum (albumName) {
    albumName = albumName.toString();

    let albumInfo = null;
    let cursor = null;
    const checkFilter = (info) => {
      return info.title === albumName ||
        info.id === albumName;
    };

    do {
      const { list: albumList, next: nextCursor } =
        await this._fetchAlbumList(cursor);

      albumInfo = albumList.filter(checkFilter).shift();
      cursor = nextCursor;
    } while (!albumInfo && cursor);

    if (!albumInfo) {
      this._logger.error(`Album "${ albumName }" is not found.`);
      return null;
    }
    return albumInfo;
  }

  async fetchAllAlbumList () {
    const albumList = [];

    let cursor = null;
    do {
      const { list, next: nextCursor } = await this._fetchAlbumList(cursor);
      albumList.push(...list);
      cursor = nextCursor;
    } while (cursor);

    return albumList;
  }

  async _fetchAlbumList (next = null) {
    const reqQuery = [[
      [ 72930366, [{
        '72930366': [ (next || null), null, null, null, 1 ]
      }], null, null, 1]
    ]];
    const albumRes = await this._request({
      method: 'POST',
      url: 'https://photos.google.com/_/PhotosUi/data',
      form: {
        'f.req': JSON.stringify(reqQuery),
        at: this._atParam
      }
    });

    if (albumRes.statusCode !== 200) {
      return { list: [], next: undefined };
    }

    const results =
      (await JSON.parseAsync(albumRes.body.substr(4)))[0][2]['72930366'];

    const albumList = results[0].map((al) => {
      const info = al.pop()['72930366'];
      return new Album({
        id: al.shift(),
        title: info[1],
        period: {
          from: new Date(info[2][0]),
          to: new Date(info[2][1])
        },
        items_count: info[3],
        _parent: this
      });
    });

    return { list: albumList, next: results[1] };
  }

  async createAlbum (albumName) {
    const latestPhoto = await this._fetchLatestPhoto();
    const reqQuery = [
      'af.maf',
      [[
        'af.add',
        79956622,
        [{
          '79956622': [ [ latestPhoto.id ], null, albumName ]
        }]
      ]]
    ];

    const createAlbumRes = await this._request({
      method: 'POST',
      url: 'https://photos.google.com/_/PhotosUi/mutate',
      form: {
        'f.req': JSON.stringify(reqQuery),
        at: this._atParam
      }
    });

    if (createAlbumRes.statusCode !== 200) {
      return null;
    }

    const [ albumId, [ insertedPhotoId ] ] =
      (await JSON.parseAsync(createAlbumRes.body.substr(4)))[0][1]['79956622'];

    await this.removePhotoFromAlbum(insertedPhotoId);

    this._logger.info(`AlbumID is ${ albumId }.`);
    return new Album({
      id: albumId,
      title: albumName,
      _parent: this
    });
  }

  async fetchAllPhotoList () {
    const photoList = [];

    let cursor = null;
    do {
      const { list, next: nextCursor } = await this._fetchPhotoList(cursor);
      photoList.push(...list);
      cursor = nextCursor;
    } while (cursor);

    return photoList;
  }

  async _fetchPhotoList (next = null) {
    const reqQuery = [[
      [ 74806772, [{
        '74806772': [ (next || null), null, null, null, 1 ]
      }], null, null, 1]
    ]];
    const photoRes = await this._request({
      method: 'POST',
      url: 'https://photos.google.com/_/PhotosUi/data',
      form: {
        'f.req': JSON.stringify(reqQuery),
        at: this._atParam
      }
    });

    if (photoRes.statusCode !== 200) {
      return { list: [], next: undefined };
    }

    const results =
      (await JSON.parseAsync(photoRes.body.substr(4)))[0][2]['74806772'];

    const photoList = results[0].map((al) => {
      const type = (al[1].pop()[0] === 15658734) ? 'video' : 'photo';
      return new Photo({
        id: al[0],
        createdAt: al[2],
        uploadedAt: al[5],
        type: type,
        length: (type === 'video') ? al[9]['76647426'][0] : null,
        width: (type === 'photo') ? al[1][1] : al[9]['76647426'][2],
        height: (type === 'photo') ? al[1][2] : al[9]['76647426'][3],
        rawUrl: al[1][0],
        _parent: this
      });
    });

    return { list: photoList, next: results[1] };
  }

  async _fetchLatestPhoto () {
    const latestPhotoList = await this._fetchPhotoList();
    return latestPhotoList.list[0];
  }

  async fetchAlbum (albumName) {
    return this.searchAlbum(albumName)
      .catch(() => this.createAlbum(albumName));
  }

  async upload (filePath, fileName) {
    fileName = fileName || path.basename(filePath);

    const fileStat =
      await fs.stat(filePath)
        .catch((err) => {
          this._logger.error(`"${ fileName }" can't access.`);
          return Promise.reject(err);
        });

    const sendInfo = reqJSONTemplateGenerator();
    for (let field of sendInfo.createSessionRequest.fields) {
      if ('external' in field) {
        field.external.filename = fileName;
        field.external.size = fileStat.size;
      } else if ('inlined' in field) {
        const name = field.inlined.name;
        if (name !== 'effective_id' && name !== 'owner_name') continue;
        field.inlined.content = this._userId;
      }
    }

    const serverStatusRes = await this._request({
      method: 'POST',
      url: 'https://photos.google.com/_/upload/photos/resumable?authuser=0',
      body: JSON.stringify(sendInfo),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
      }
    });

    if (serverStatusRes.statusCode !== 200) {
      this._logger.error(`Server Error: ${ serverStatusRes.statusCode }`);
      return Promise.reject(new Error(`Server Error: ${ serverStatusRes.statusCode }`));
    }

    const serverStatus = JSON.parse(serverStatusRes.body);
    if (!('sessionStatus' in serverStatus)) {
      this._logger.error('Server Error: sessionStatus is not found.');
      return Promise.reject(new Error('Server Error: sessionStatus is not found.'));
    }

    const sendUrl =
      serverStatus.sessionStatus.externalFieldTransfers[0].putInfo.url;

    const fileReadStream = fs.createReadStream(filePath);

    if (this.options.progressbar) {
      const progressBar = new ProgressBar(colors.green('Uploading') + ' [:bar] :percent :etas', {
        complete: '=',
        incomplete: '\x20',
        width: Math.max(0, process.stdout.columns - 25),
        total: fileStat.size
      });
      fileReadStream.on('open', () => process.stderr.write('\n'));
      fileReadStream.on('data', (chunk) => {
        progressBar.tick(chunk.length);
      });
      fileReadStream.on('end', () => process.stderr.write('\n'));
    }

    const resultRes = await this._request({
      method: 'POST',
      url: sendUrl,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-HTTP-Method-Override': 'PUT'
      },
      body: fileReadStream
    });

    const result = JSON.parse(resultRes.body);
    if (result.sessionStatus.state !== 'FINALIZED') {
      this._logger.error(`Upload Error: ${ result.sessionStatus.state }`);
      return Promise.reject(new Error(`Upload Error: ${ result.sessionStatus.state }`));
    }

    this._logger.info('Uploaded successfully!');

    const uploadInfo =
      result.sessionStatus
        .additionalInfo['uploader_service.GoogleRupioAdditionalInfo']
        .completionInfo
        .customerSpecificInfo;

    const uploadedPhoto = new Photo({
      id: uploadInfo.photoMediaKey,
      uploadedAt: new Date(),
      createdAt: uploadInfo.timestamp * 1000,
      type: uploadInfo.kind,
      title: uploadInfo.title,
      rawUrl: uploadInfo.url,
      uploadInfo: uploadInfo,
      _parent: this
    });
    return uploadedPhoto;
  }
}

export default GPhotos;
